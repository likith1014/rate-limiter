/**
 * Token Bucket Algorithm
 *
 * Used by: AWS API Gateway, Stripe, Twilio
 *
 * Concept: A bucket holds tokens up to a maximum capacity. Tokens are added
 * at a fixed refill rate. Each request consumes one (or more) tokens.
 * If the bucket is empty, the request is rejected.
 *
 * Strengths:
 *  - Allows controlled bursting (up to bucket capacity)
 *  - Smooth average rate enforcement
 *  - Memory efficient (one record per key)
 *
 * Weaknesses:
 *  - Can allow large bursts at boundary edges if not tuned carefully
 */

class TokenBucket {
  /**
   * @param {Object} options
   * @param {number} options.capacity       - Max tokens the bucket can hold
   * @param {number} options.refillRate     - Tokens added per second
   * @param {number} [options.refillInterval=1000] - Refill interval in ms
   * @param {Object} [options.store]        - Pluggable store (default: InMemoryStore)
   */
  constructor({ capacity, refillRate, refillInterval = 1000, store = null }) {
    if (!capacity || capacity <= 0) throw new Error("capacity must be a positive number");
    if (!refillRate || refillRate <= 0) throw new Error("refillRate must be a positive number");

    this.capacity = capacity;
    this.refillRate = refillRate;
    this.refillInterval = refillInterval;
    this.store = store || new InMemoryBucketStore();
  }

  /**
   * Attempt to consume `tokens` tokens for a given key.
   *
   * @param {string} key    - Identifier (e.g., user ID, IP, API key)
   * @param {number} [tokens=1] - Number of tokens to consume
   * @returns {Promise<RateLimitResult>}
   */
  async consume(key, tokens = 1) {
    const now = Date.now();
    let bucket = await this.store.get(key);

    if (!bucket) {
      // First request: initialize full bucket
      bucket = {
        tokens: this.capacity,
        lastRefill: now,
      };
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = (elapsed / this.refillInterval) * this.refillRate;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    const allowed = bucket.tokens >= tokens;

    if (allowed) {
      bucket.tokens -= tokens;
    }

    await this.store.set(key, bucket, this._ttlSeconds());

    const remaining = Math.floor(bucket.tokens);
    const resetAfterMs = allowed
      ? Math.ceil(((tokens - 0) / this.refillRate) * this.refillInterval)
      : Math.ceil(((tokens - bucket.tokens) / this.refillRate) * this.refillInterval);

    return {
      allowed,
      remaining,
      limit: this.capacity,
      resetAfter: Math.max(0, resetAfterMs),
      retryAfter: allowed ? 0 : Math.ceil(resetAfterMs / 1000),
      algorithm: "token-bucket",
      key,
    };
  }

  /**
   * Peek at current bucket state without consuming tokens.
   */
  async peek(key) {
    const bucket = await this.store.get(key);
    if (!bucket) return { tokens: this.capacity, remaining: this.capacity };
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = (elapsed / this.refillInterval) * this.refillRate;
    const current = Math.min(this.capacity, bucket.tokens + tokensToAdd);
    return { tokens: Math.floor(current), remaining: Math.floor(current) };
  }

  /**
   * Reset bucket for a key (e.g., after a successful payment retry).
   */
  async reset(key) {
    await this.store.delete(key);
  }

  _ttlSeconds() {
    return Math.ceil((this.capacity / this.refillRate) * (this.refillInterval / 1000)) + 60;
  }
}

/**
 * Simple in-memory store for single-instance usage.
 * For distributed systems, swap with RedisStore.
 */
class InMemoryBucketStore {
  constructor() {
    this._data = new Map();
    this._timers = new Map();
  }

  async get(key) {
    return this._data.get(key) || null;
  }

  async set(key, value, ttlSeconds) {
    this._data.set(key, value);
    if (this._timers.has(key)) clearTimeout(this._timers.get(key));
    const timer = setTimeout(() => this._data.delete(key), ttlSeconds * 1000);
    if (timer.unref) timer.unref(); // Don't block process exit
    this._timers.set(key, timer);
  }

  async delete(key) {
    this._data.delete(key);
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key));
      this._timers.delete(key);
    }
  }

  size() {
    return this._data.size;
  }
}

module.exports = { TokenBucket, InMemoryBucketStore };
