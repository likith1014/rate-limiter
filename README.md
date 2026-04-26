# 🚦 Production Rate Limiter

> A Google/Netflix-grade API rate limiting library — multiple algorithms, Redis-backed distributed storage, Prometheus monitoring, and Express middleware. Production-ready.

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](./tests/run-all.js)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Algorithms](https://img.shields.io/badge/algorithms-4-orange)](#algorithms)

---

## Why This Exists

Every major API at scale (GitHub, Stripe, Netflix, Google) enforces rate limits differently. This library implements **all four** canonical algorithms with a unified interface, pluggable storage, and production-grade observability — so you understand the tradeoffs and can deploy the right strategy for your use case.

---

## Algorithms

| Algorithm | Memory | Burst Allowed | Accuracy | Best For |
|-----------|--------|---------------|----------|----------|
| **Token Bucket** | O(1) | ✅ Yes | High | AWS, Stripe, Twilio |
| **Sliding Window Log** | O(n) | ❌ No | Perfect | GitHub, Cloudflare |
| **Sliding Window Counter** | O(1) | ❌ No | ~99.9% | Google, Nginx |
| **Leaky Bucket** | O(1) | ❌ No | Exact output | Netflix, HAProxy |

### Token Bucket
Tokens accumulate up to a capacity. Each request consumes tokens. Unused capacity carries over, enabling legitimate burst traffic.

```
Capacity: ████████████ (12 tokens)
Request:  ██ (costs 2)
Result:   ██████████   (10 remaining)
```

### Sliding Window Log
Tracks exact timestamps of each request. Perfectly accurate but O(n) memory.

```
Window: [────────── 60 seconds ──────────]
Log:    [req1, req2, req3, req4, req5]
New req → count=5 < limit=10 → ALLOW
```

### Sliding Window Counter (Google's Algorithm)
Interpolates between two fixed-window counters for O(1) memory with near-perfect accuracy.

```
Prev window: 80 reqs   Current window: 20 reqs
Elapsed: 25% into current window
Estimate = 80 × (1 - 0.25) + 20 = 80 → near limit
```

### Leaky Bucket
Requests fill a queue that drains at a fixed rate. Guarantees smooth output regardless of input burst.

```
Input:  ▓▓▓▓▓▓▓▓▓▓ (bursty)
Bucket: [████████  ] (filling)
Output: ─ ─ ─ ─ ─ ─ (smooth drain)
```

---

## Quick Start

```bash
git clone https://github.com/yourusername/rate-limiter
cd rate-limiter
node examples/demo.js     # See all algorithms in action
node tests/run-all.js     # Run test suite
node examples/benchmark.js # Performance numbers
```

---

## Usage

### Single Algorithm

```javascript
const { TokenBucket } = require('./src');

const limiter = new TokenBucket({
  capacity: 100,      // Max burst: 100 requests
  refillRate: 10,     // Sustained: 10 requests/second
});

const result = await limiter.consume('user:alice');

if (!result.allowed) {
  res.status(429).json({
    error: 'Too Many Requests',
    retryAfter: result.retryAfter,
  });
}
```

### Multi-Tier (Production Standard)

```javascript
const { CompositeRateLimiter, TokenBucket, SlidingWindowCounter } = require('./src');

// GitHub-style: 60/min burst + 5000/hr sustained
const limiter = new CompositeRateLimiter([
  {
    name: 'per-minute',
    limiter: new TokenBucket({ capacity: 60, refillRate: 1 }),
  },
  {
    name: 'per-hour',
    limiter: new SlidingWindowCounter({ limit: 5000, windowMs: 3_600_000 }),
  },
]);

const result = await limiter.consume('user:alice');
// result.tiers[0] → per-minute status
// result.tiers[1] → per-hour status
// result.headers  → X-RateLimit-* headers (RFC-compliant)
```

### Express Middleware

```javascript
const express = require('express');
const { TokenBucket, createMiddleware, DEFAULT_KEY_EXTRACTORS } = require('./src');

const app = express();

const limiter = new TokenBucket({ capacity: 100, refillRate: 10 });

app.use('/api', createMiddleware(limiter, {
  keyExtractor: DEFAULT_KEY_EXTRACTORS.apiKey,  // or .ip, .userId
  onLimitReached: (req, res, result) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: result.retryAfter,
      limit: result.limit,
    });
  },
  skip: [
    (req) => req.headers['x-internal-service'] === process.env.SERVICE_SECRET,
  ],
}));
```

### Redis (Distributed / Production)

```javascript
const redis = require('redis');
const { TokenBucket, RedisBucketStore } = require('./src');

const client = redis.createClient({ url: process.env.REDIS_URL });
await client.connect();

const limiter = new TokenBucket({
  capacity: 1000,
  refillRate: 100,
  store: new RedisBucketStore(client, { keyPrefix: 'myapp:rl:' }),
});

// Now safe across multiple Node.js instances / pods
```

### Weighted Requests

```javascript
const { SlidingWindowLog } = require('./src');

const limiter = new SlidingWindowLog({ limit: 1000, windowMs: 3_600_000 });

// Different endpoints have different costs
await limiter.consume('user:alice', 1);   // GET  /users
await limiter.consume('user:alice', 3);   // GET  /search
await limiter.consume('user:alice', 10);  // POST /export (expensive)
```

### Monitoring & Prometheus

```javascript
const { MonitoredLimiter, TokenBucket } = require('./src');

const limiter = new MonitoredLimiter(
  new TokenBucket({ capacity: 100, refillRate: 10 }),
  {
    onMetric: ({ name, tags }) => statsd.increment(name, tags),
  }
);

// Expose Prometheus metrics endpoint
app.get('/metrics', (req, res) => {
  res.type('text/plain').send(limiter.toPrometheusFormat());
});

// Get snapshot
const metrics = limiter.getMetrics();
// {
//   summary: { totalRequests, allowedRequests, blockedRequests, blockRatePercent, avgDecisionLatencyMs },
//   topConsumers: [...],
//   topBlocked: [...],
//   blocksByAlgorithm: { 'token-bucket': 42 },
// }
```

---

## Response Object

All algorithms return a consistent result shape:

```javascript
{
  allowed: true,              // Whether the request was permitted
  remaining: 87,              // Tokens/slots remaining in current window
  limit: 100,                 // Configured maximum
  resetAfter: 5000,           // Milliseconds until limit resets
  retryAfter: 5,              // Seconds to wait before retrying (if blocked)
  algorithm: "token-bucket",  // Algorithm that made the decision
  key: "user:alice",          // The key that was consumed against
}
```

### Standard Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1735689600
X-RateLimit-Algorithm: token-bucket
Retry-After: 5
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│              HTTP Layer                      │
│  createMiddleware() → key extraction        │
│  429 handling → RFC 7807 Problem Details    │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           CompositeRateLimiter               │
│  Tier 1: per-second  (TokenBucket)          │
│  Tier 2: per-minute  (SlidingWindowLog)     │
│  Tier 3: per-day     (SlidingWindowCounter) │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              Storage Layer                   │
│  InMemory (single process)                  │
│  Redis    (distributed, atomic Lua scripts) │
└─────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           MonitoredLimiter                   │
│  Prometheus metrics / StatsD emission       │
│  Top consumer tracking / block analysis     │
└─────────────────────────────────────────────┘
```

---

## Why Atomic Lua Scripts for Redis?

Naive distributed rate limiting:
```
1. GET current_count      ← race condition window
2. if count < limit:
3.   SET new_count        ← another server may have also incremented
```

This library uses Redis Lua scripts that execute atomically:
```lua
local count = redis.call('INCRBY', key, cost)
if count == cost then
  redis.call('EXPIRE', key, ttl)  -- only set TTL on first write
end
return count
```
No race condition. Safe across any number of pods.

---

## Design Decisions & Tradeoffs

### Why not just use a library like `express-rate-limit`?
This project exists to demonstrate deep understanding of the underlying algorithms — the tradeoffs between accuracy, memory, burst tolerance, and distributed correctness. This is what a senior interview at Google, Netflix, or Stripe would ask you to design.

### Fail Open vs Fail Closed
The Express middleware defaults to **fail open** (allow requests if the store is unavailable). This is the correct choice for most APIs — a Redis outage should not take down your service. Override `onError` to fail closed if your use case requires it.

### Clock Skew in Distributed Systems
Redis-backed implementations are safe from clock skew since all time calculations happen server-side in Lua scripts or use Redis server time. The in-memory stores rely on local `Date.now()`.

---

## Running Tests

```bash
node tests/run-all.js
```

```
🪣  Token Bucket
  ✓ allows requests within capacity
  ✓ blocks requests that exceed capacity
  ✓ refills tokens over time
  ✓ returns correct result shape
  ✓ isolates keys independently
  ✓ reset clears bucket state
  ✓ throws on invalid configuration

📜  Sliding Window Log
  ✓ allows requests within limit
  ...

Results: 32 passed, 0 failed
✅  All tests passed!
```

---

## License

MIT — use freely, attribution appreciated.
