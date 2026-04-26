/**
 * Leaky Bucket Algorithm
 *
 * Used by: Netflix Zuul, HAProxy, older telephony systems
 *
 * Concept: Requests fill a "bucket" (queue). The bucket drains at a
 * fixed rate regardless of input volume. If the bucket is full,
 * new requests overflow (are rejected).
 *
 * Strengths:
 *  - Guarantees a perfectly smooth output rate
 *  - Great for protecting downstream services from any bursting
 *  - Classic traffic shaping technique
 *
 * Weaknesses:
 *  - No burst allowance — even momentary spikes are rejected
 *  - Can feel unfair to legitimate bursty clients
 *
 * Best for: Downstream service protection, video streaming pipelines (Netflix),
 *           payment processing where steady drip is critical.
 *
 * Note: "As a meter" variant (this implementation) rejects excess immediately
 * vs. "as a queue" variant which delays. The meter variant is standard for
 * HTTP APIs.
 */

class LeakyBucket {
  /**
   * @param {Object} options
   * @param {number} options.capacity    - Max queue depth (burst tolerance)
   * @param {number} options.leakRate    - Requests drained per second
   * @param {Object} [options.store]
   */
  constructor({ capacity, leakRate, store = null }) {
    if (!capacity || capacity <= 0) throw new Error("capacity must be a positive number");
    if (!leakRate || leakRate <= 0) throw new Error("leakRate must be a positive number");

    this.capacity = capacity;
    this.leakRate = leakRate; // requests per second that "drain" out
    this.store = store || new InMemoryLeakStore();
  }

  /**
   * @param {string} key
   * @returns {Promise<RateLimitResult>}
   */
  async consume(key) {
    const now = Date.now();
    let bucket = await this.store.get(key);

    if (!bucket) {
      bucket = { level: 0, lastLeak: now };
    }

    // Calculate how much has leaked since last check
    const elapsed = (now - bucket.lastLeak) / 1000; // seconds
    const leaked = elapsed * this.leakRate;
    bucket.level = Math.max(0, bucket.level - leaked);
    bucket.lastLeak = now;

    const allowed = bucket.level < this.capacity;

    if (allowed) {
      bucket.level += 1;
    }

    await this.store.set(key, bucket, Math.ceil(this.capacity / this.leakRate) + 60);

    const remaining = Math.max(0, Math.floor(this.capacity - bucket.level));

    // Time until bucket has room for one more request
    const retryAfterMs = allowed
      ? 0
      : Math.ceil(((bucket.level - this.capacity + 1) / this.leakRate) * 1000);

    return {
      allowed,
      remaining,
      limit: this.capacity,
      resetAfter: retryAfterMs,
      retryAfter: allowed ? 0 : Math.ceil(retryAfterMs / 1000),
      algorithm: "leaky-bucket",
      key,
      currentLevel: Math.ceil(bucket.level),
    };
  }

  async status(key) {
    const bucket = await this.store.get(key);
    if (!bucket) return { level: 0, remaining: this.capacity };
    const now = Date.now();
    const elapsed = (now - bucket.lastLeak) / 1000;
    const level = Math.max(0, bucket.level - elapsed * this.leakRate);
    return {
      level: Math.ceil(level),
      remaining: Math.max(0, Math.floor(this.capacity - level)),
    };
  }

  async reset(key) {
    await this.store.delete(key);
  }
}

class InMemoryLeakStore {
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
    if (timer.unref) timer.unref();
    this._timers.set(key, timer);
  }

  async delete(key) {
    this._data.delete(key);
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key));
      this._timers.delete(key);
    }
  }
}

module.exports = { LeakyBucket, InMemoryLeakStore };
