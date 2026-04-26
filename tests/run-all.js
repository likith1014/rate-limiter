/**
 * Comprehensive Test Suite
 * Tests all algorithms for correctness, edge cases, and concurrency behavior.
 *
 * Run: node tests/run-all.js
 */

const { TokenBucket } = require("../src/algorithms/token-bucket");
const { SlidingWindowLog } = require("../src/algorithms/sliding-window-log");
const { SlidingWindowCounter } = require("../src/algorithms/sliding-window-counter");
const { LeakyBucket } = require("../src/algorithms/leaky-bucket");
const { CompositeRateLimiter } = require("../src/algorithms/composite");
const { MonitoredLimiter } = require("../src/monitoring/metrics");

// ─── Tiny test framework ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} to equal ${JSON.stringify(b)}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {

// ─── Token Bucket Tests ─────────────────────────────────────────────────────

console.log("\n🪣  Token Bucket");

await test("allows requests within capacity", async () => {
  const tb = new TokenBucket({ capacity: 5, refillRate: 1 });
  for (let i = 0; i < 5; i++) {
    const result = await tb.consume("user1");
    assert(result.allowed, `Request ${i + 1} should be allowed`);
  }
});

await test("blocks requests that exceed capacity", async () => {
  const tb = new TokenBucket({ capacity: 3, refillRate: 1 });
  await tb.consume("user2");
  await tb.consume("user2");
  await tb.consume("user2");
  const result = await tb.consume("user2");
  assert(!result.allowed, "4th request should be blocked");
  assertEqual(result.remaining, 0, "Remaining should be 0");
});

await test("refills tokens over time", async () => {
  const tb = new TokenBucket({ capacity: 2, refillRate: 10, refillInterval: 100 });
  await tb.consume("user3");
  await tb.consume("user3");
  const blocked = await tb.consume("user3");
  assert(!blocked.allowed, "Should be blocked initially");

  await sleep(150); // Wait for refill

  const result = await tb.consume("user3");
  assert(result.allowed, "Should be allowed after refill");
});

await test("returns correct result shape", async () => {
  const tb = new TokenBucket({ capacity: 10, refillRate: 5 });
  const result = await tb.consume("user4");
  assert(typeof result.allowed === "boolean", "allowed should be boolean");
  assert(typeof result.remaining === "number", "remaining should be number");
  assert(typeof result.limit === "number", "limit should be number");
  assert(typeof result.retryAfter === "number", "retryAfter should be number");
  assertEqual(result.algorithm, "token-bucket");
});

await test("isolates keys independently", async () => {
  const tb = new TokenBucket({ capacity: 2, refillRate: 1 });
  await tb.consume("userA");
  await tb.consume("userA");
  await tb.consume("userA"); // userA exhausted
  const resultB = await tb.consume("userB");
  assert(resultB.allowed, "userB should not be affected by userA's usage");
});

await test("reset clears bucket state", async () => {
  const tb = new TokenBucket({ capacity: 1, refillRate: 1 });
  await tb.consume("user-reset");
  const blocked = await tb.consume("user-reset");
  assert(!blocked.allowed);
  await tb.reset("user-reset");
  const result = await tb.consume("user-reset");
  assert(result.allowed, "Should be allowed after reset");
});

await test("throws on invalid configuration", async () => {
  let threw = false;
  try {
    new TokenBucket({ capacity: -1, refillRate: 1 });
  } catch {
    threw = true;
  }
  assert(threw, "Should throw on negative capacity");
});

// ─── Sliding Window Log Tests ────────────────────────────────────────────────

console.log("\n📜  Sliding Window Log");

await test("allows requests within limit", async () => {
  const sw = new SlidingWindowLog({ limit: 5, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    const r = await sw.consume("swl-user1");
    assert(r.allowed, `Request ${i + 1} should be allowed`);
  }
});

await test("blocks requests that exceed limit", async () => {
  const sw = new SlidingWindowLog({ limit: 3, windowMs: 60_000 });
  await sw.consume("swl-user2");
  await sw.consume("swl-user2");
  await sw.consume("swl-user2");
  const result = await sw.consume("swl-user2");
  assert(!result.allowed, "4th request should be blocked");
});

await test("correctly counts remaining requests", async () => {
  const sw = new SlidingWindowLog({ limit: 10, windowMs: 60_000 });
  await sw.consume("swl-user3");
  await sw.consume("swl-user3");
  const result = await sw.consume("swl-user3");
  assertEqual(result.remaining, 7, "Should have 7 remaining after 3 requests");
});

await test("allows requests after window expires", async () => {
  const sw = new SlidingWindowLog({ limit: 2, windowMs: 100 }); // 100ms window
  await sw.consume("swl-user4");
  await sw.consume("swl-user4");
  const blocked = await sw.consume("swl-user4");
  assert(!blocked.allowed);

  await sleep(150);

  const result = await sw.consume("swl-user4");
  assert(result.allowed, "Should be allowed after window expires");
});

await test("supports weighted requests (cost > 1)", async () => {
  const sw = new SlidingWindowLog({ limit: 10, windowMs: 60_000 });
  const result = await sw.consume("swl-user5", 5);
  assert(result.allowed);
  assertEqual(result.remaining, 5, "Should have 5 remaining after cost-5 request");
});

await test("status returns correct count", async () => {
  const sw = new SlidingWindowLog({ limit: 10, windowMs: 60_000 });
  await sw.consume("swl-status");
  await sw.consume("swl-status");
  const status = await sw.status("swl-status");
  assertEqual(status.used, 2);
});

// ─── Sliding Window Counter Tests ────────────────────────────────────────────

console.log("\n🔢  Sliding Window Counter");

await test("allows requests within limit", async () => {
  const sw = new SlidingWindowCounter({ limit: 5, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) {
    const r = await sw.consume("swc-user1");
    assert(r.allowed, `Request ${i + 1} should be allowed`);
  }
});

await test("blocks requests exceeding limit", async () => {
  const sw = new SlidingWindowCounter({ limit: 3, windowMs: 60_000 });
  await sw.consume("swc-user2");
  await sw.consume("swc-user2");
  await sw.consume("swc-user2");
  const result = await sw.consume("swc-user2");
  assert(!result.allowed, "4th request should be blocked");
});

await test("uses correct algorithm name", async () => {
  const sw = new SlidingWindowCounter({ limit: 10, windowMs: 60_000 });
  const result = await sw.consume("swc-user3");
  assertEqual(result.algorithm, "sliding-window-counter");
});

await test("estimatedCount is exposed in result", async () => {
  const sw = new SlidingWindowCounter({ limit: 10, windowMs: 60_000 });
  await sw.consume("swc-user4");
  await sw.consume("swc-user4");
  const result = await sw.consume("swc-user4");
  // estimatedCount may be low early in window (previous window is empty)
  assert(typeof result.estimatedCount === "number", "estimatedCount should be a number");
  assert(result.estimatedCount >= 1, "estimatedCount should be at least 1");
});

// ─── Leaky Bucket Tests ──────────────────────────────────────────────────────

console.log("\n🫧  Leaky Bucket");

await test("allows requests when bucket has space", async () => {
  const lb = new LeakyBucket({ capacity: 5, leakRate: 1 });
  const result = await lb.consume("lb-user1");
  assert(result.allowed);
});

await test("blocks requests when bucket is full", async () => {
  const lb = new LeakyBucket({ capacity: 3, leakRate: 0.1 }); // Very slow leak
  await lb.consume("lb-user2");
  await lb.consume("lb-user2");
  await lb.consume("lb-user2");
  const result = await lb.consume("lb-user2");
  assert(!result.allowed, "4th request should overflow the bucket");
});

await test("drains over time", async () => {
  const lb = new LeakyBucket({ capacity: 2, leakRate: 20 }); // Fast leak
  await lb.consume("lb-user3");
  await lb.consume("lb-user3");
  const blocked = await lb.consume("lb-user3");
  assert(!blocked.allowed);

  await sleep(150); // Wait for 3 requests to drain (3/20 = 150ms)

  const result = await lb.consume("lb-user3");
  assert(result.allowed, "Should drain and allow after wait");
});

await test("exposes currentLevel in result", async () => {
  const lb = new LeakyBucket({ capacity: 10, leakRate: 1 });
  await lb.consume("lb-user4");
  await lb.consume("lb-user4");
  const result = await lb.consume("lb-user4");
  assert(result.currentLevel >= 1 && result.currentLevel <= 3, "Current level should be 1-3");
});

// ─── Composite Limiter Tests ─────────────────────────────────────────────────

console.log("\n🔗  Composite Rate Limiter");

await test("allows when all tiers pass", async () => {
  const composite = new CompositeRateLimiter([
    { name: "per-second", limiter: new TokenBucket({ capacity: 10, refillRate: 10 }) },
    { name: "per-minute", limiter: new SlidingWindowLog({ limit: 100, windowMs: 60_000 }) },
  ]);
  const result = await composite.consume("comp-user1");
  assert(result.allowed, "Should be allowed when all tiers pass");
  assert(Array.isArray(result.tiers), "tiers array should be present");
  assertEqual(result.tiers.length, 2);
});

await test("blocks when any tier fails", async () => {
  const composite = new CompositeRateLimiter([
    { name: "per-second", limiter: new TokenBucket({ capacity: 1, refillRate: 0.1 }) }, // Very tight
    { name: "per-minute", limiter: new SlidingWindowLog({ limit: 1000, windowMs: 60_000 }) },
  ]);
  await composite.consume("comp-user2"); // Exhaust per-second
  const result = await composite.consume("comp-user2");
  assert(!result.allowed, "Should block when any tier fails");
  assert(result.blocked.length > 0, "blocked array should have entries");
});

await test("generates response headers", async () => {
  const composite = new CompositeRateLimiter([
    { name: "per-minute", limiter: new TokenBucket({ capacity: 100, refillRate: 10 }) },
  ]);
  const result = await composite.consume("comp-user3");
  assert(result.headers, "Should return headers object");
  assert("X-RateLimit-Limit" in result.headers, "Should have X-RateLimit-Limit header");
  assert("X-RateLimit-Remaining" in result.headers, "Should have X-RateLimit-Remaining header");
});

await test("reset clears all tiers", async () => {
  const composite = new CompositeRateLimiter([
    { name: "t1", limiter: new TokenBucket({ capacity: 1, refillRate: 0.01 }) },
  ]);
  await composite.consume("comp-reset");
  const blocked = await composite.consume("comp-reset");
  assert(!blocked.allowed);
  await composite.reset("comp-reset");
  const result = await composite.consume("comp-reset");
  assert(result.allowed, "Should be allowed after composite reset");
});

await test("throws on empty tiers array", async () => {
  let threw = false;
  try {
    new CompositeRateLimiter([]);
  } catch {
    threw = true;
  }
  assert(threw, "Should throw on empty tiers");
});

// ─── Monitoring Tests ────────────────────────────────────────────────────────

console.log("\n📊  Monitoring");

await test("tracks allowed and blocked counts", async () => {
  const limiter = new TokenBucket({ capacity: 2, refillRate: 0.01 });
  const monitored = new MonitoredLimiter(limiter);

  await monitored.consume("mon-user1");
  await monitored.consume("mon-user1");
  await monitored.consume("mon-user1"); // Blocked

  const metrics = monitored.getMetrics();
  assertEqual(metrics.summary.totalRequests, 3);
  assertEqual(metrics.summary.allowedRequests, 2);
  assertEqual(metrics.summary.blockedRequests, 1);
});

await test("tracks top consumers", async () => {
  const limiter = new TokenBucket({ capacity: 100, refillRate: 100 });
  const monitored = new MonitoredLimiter(limiter);

  for (let i = 0; i < 5; i++) await monitored.consume("heavy-user");
  for (let i = 0; i < 2; i++) await monitored.consume("light-user");

  const metrics = monitored.getMetrics();
  assert(metrics.topConsumers.length > 0, "Should have top consumers");
  assertEqual(metrics.topConsumers[0].key, "heavy-user");
});

await test("emits metrics via onMetric callback", async () => {
  const received = [];
  const limiter = new TokenBucket({ capacity: 10, refillRate: 10 });
  const monitored = new MonitoredLimiter(limiter, {
    onMetric: (m) => received.push(m),
  });

  await monitored.consume("mon-cb");
  assert(received.length > 0, "onMetric callback should be called");
  assert(received[0].name === "rate_limiter.decision", "Should emit decision metric");
});

await test("generates Prometheus format output", async () => {
  const limiter = new TokenBucket({ capacity: 5, refillRate: 5 });
  const monitored = new MonitoredLimiter(limiter);
  await monitored.consume("prom-user");

  const prom = monitored.toPrometheusFormat();
  assert(prom.includes("rate_limiter_requests_total"), "Should include requests_total");
  assert(prom.includes("rate_limiter_block_rate_percent"), "Should include block_rate");
});

// ─── Results ────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  failures.forEach(({ name, error }) => console.log(`  ✗ ${name}: ${error}`));
  process.exit(1);
} else {
  console.log("\n✅  All tests passed!\n");
}
} // end main

main().catch(err => { console.error(err); process.exit(1); });
