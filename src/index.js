/**
 * @elite/rate-limiter
 *
 * Production-grade API rate limiter with multiple algorithms,
 * distributed Redis backend, and Prometheus-compatible monitoring.
 *
 * Algorithms:
 *   - TokenBucket         (AWS, Stripe, Twilio)
 *   - SlidingWindowLog    (GitHub, Cloudflare)
 *   - SlidingWindowCounter (Google, Nginx)
 *   - LeakyBucket         (Netflix Zuul, HAProxy)
 *   - CompositeRateLimiter (multi-tier, any real production API)
 *
 * Stores:
 *   - InMemory (single-process, testing)
 *   - Redis    (distributed, production)
 *
 * @example Quick Start
 *   const { TokenBucket, createMiddleware } = require('@elite/rate-limiter');
 *   const limiter = new TokenBucket({ capacity: 100, refillRate: 10 });
 *   app.use(createMiddleware(limiter));
 *
 * @example Production (Redis + Multi-tier + Monitoring)
 *   const { CompositeRateLimiter, SlidingWindowCounter, MonitoredLimiter } = require('@elite/rate-limiter');
 *   const { RedisBucketStore } = require('@elite/rate-limiter/storage');
 *
 *   const limiter = new MonitoredLimiter(
 *     new CompositeRateLimiter([
 *       { name: 'per-second', limiter: new TokenBucket({ capacity: 20, refillRate: 20 }) },
 *       { name: 'per-hour',   limiter: new SlidingWindowCounter({ limit: 1000, windowMs: 3_600_000 }) },
 *     ])
 *   );
 */

const { TokenBucket } = require("./algorithms/token-bucket");
const { SlidingWindowLog } = require("./algorithms/sliding-window-log");
const { SlidingWindowCounter } = require("./algorithms/sliding-window-counter");
const { LeakyBucket } = require("./algorithms/leaky-bucket");
const { CompositeRateLimiter } = require("./algorithms/composite");
const { createMiddleware, DEFAULT_KEY_EXTRACTORS } = require("./middleware/http");
const { MonitoredLimiter } = require("./monitoring/metrics");
const {
  RedisBucketStore,
  RedisLogStore,
  RedisCounterStore,
  MockRedisClient,
} = require("./storage/redis-store");

module.exports = {
  // Algorithms
  TokenBucket,
  SlidingWindowLog,
  SlidingWindowCounter,
  LeakyBucket,
  CompositeRateLimiter,

  // Middleware
  createMiddleware,
  DEFAULT_KEY_EXTRACTORS,

  // Monitoring
  MonitoredLimiter,

  // Storage
  RedisBucketStore,
  RedisLogStore,
  RedisCounterStore,
  MockRedisClient,
};
