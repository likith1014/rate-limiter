/**
 * Sliding Window Counter Algorithm
 *
 * Used by: Google Cloud Endpoints, Nginx, Envoy Proxy
 *
 * Concept: Hybrid of fixed-window and sliding-window-log.
 * Maintains counters for current and previous fixed windows, then
 * interpolates based on how far into the current window we are.
 *
 * Formula:
 *   estimatedCount = prevCount * (1 - elapsed/windowMs) + currCount
 *
 * Strengths:
 *  - O(1) memory per key (only stores 2 counters)
 *  - Very accurate — within ~0.003% of true sliding window in practice
 *  - Extremely fast
 *
 * Weaknesses:
 *  - Approximate, not exact (though error margin is negligible)
 *
 * Best for: High-throughput APIs where O(1) memory is critical.
 * This is Google's preferred algorithm for large-scale systems.
 */

class SlidingWindowCounter {
  /**
   * @param {Object} options
   * @param {number} options.limit      - Max requests per window
   * @param {number} options.windowMs   - Window duration in milliseconds
   * @param {Object} [options.store]
   */
  constructor({ limit, windowMs, store = null }) {
    if (!limit || limit <= 0) throw new Error("limit must be a positive number");
    if (!windowMs || windowMs <= 0) throw new Error("windowMs must be a positive number");

    this.limit = limit;
    this.windowMs = windowMs;
    this.store = store || new InMemoryCounterStore();
  }

  /**
   * @param {string} key
   * @param {number} [cost=1]
   * @returns {Promise<RateLimitResult>}
   */
  async consume(key, cost = 1) {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.windowMs);
    const previousWindow = currentWindow - 1;

    const currKey = `${key}:${currentWindow}`;
    const prevKey = `${key}:${previousWindow}`;

    const [currCount, prevCount] = await Promise.all([
      this.store.get(currKey).then((v) => v || 0),
      this.store.get(prevKey).then((v) => v || 0),
    ]);

    // How far into the current window are we? (0.0 - 1.0)
    const elapsedInWindow = now - currentWindow * this.windowMs;
    const windowFraction = elapsedInWindow / this.windowMs;

    // Weighted estimate of requests in the sliding window
    const estimatedCount = prevCount * (1 - windowFraction) + currCount;

    const allowed = estimatedCount + cost <= this.limit;

    if (allowed) {
      await this.store.increment(currKey, cost, Math.ceil((this.windowMs * 2) / 1000) + 5);
    }

    const remaining = Math.max(0, this.limit - estimatedCount - (allowed ? cost : 0));

    // Estimate when enough of the prev window expires to allow more requests
    let retryAfter = 0;
    if (!allowed) {
      // How much of prev window needs to roll off to free up `cost` slots?
      const excessRequests = estimatedCount + cost - this.limit;
      const fractionNeeded = excessRequests / prevCount;
      const msNeeded = fractionNeeded * this.windowMs - elapsedInWindow;
      retryAfter = Math.max(1, Math.ceil(msNeeded / 1000));
    }

    return {
      allowed,
      remaining: Math.floor(remaining),
      limit: this.limit,
      resetAfter: retryAfter * 1000,
      retryAfter,
      algorithm: "sliding-window-counter",
      key,
      windowMs: this.windowMs,
      estimatedCount: Math.ceil(estimatedCount),
    };
  }

  async status(key) {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.windowMs);
    const previousWindow = currentWindow - 1;
    const currKey = `${key}:${currentWindow}`;
    const prevKey = `${key}:${previousWindow}`;

    const [currCount, prevCount] = await Promise.all([
      this.store.get(currKey).then((v) => v || 0),
      this.store.get(prevKey).then((v) => v || 0),
    ]);

    const elapsedInWindow = now - currentWindow * this.windowMs;
    const windowFraction = elapsedInWindow / this.windowMs;
    const estimatedCount = prevCount * (1 - windowFraction) + currCount;

    return {
      estimatedCount: Math.ceil(estimatedCount),
      remaining: Math.max(0, Math.floor(this.limit - estimatedCount)),
      limit: this.limit,
    };
  }

  async reset(key) {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.windowMs);
    await Promise.all([
      this.store.delete(`${key}:${currentWindow}`),
      this.store.delete(`${key}:${currentWindow - 1}`),
    ]);
  }
}

class InMemoryCounterStore {
  constructor() {
    this._data = new Map();
    this._timers = new Map();
  }

  async get(key) {
    return this._data.get(key) || null;
  }

  async increment(key, amount = 1, ttlSeconds) {
    const current = this._data.get(key) || 0;
    this._data.set(key, current + amount);

    if (!this._timers.has(key)) {
      const timer = setTimeout(() => {
        this._data.delete(key);
        this._timers.delete(key);
      }, ttlSeconds * 1000);
      if (timer.unref) timer.unref();
      this._timers.set(key, timer);
    }
    return current + amount;
  }

  async delete(key) {
    this._data.delete(key);
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key));
      this._timers.delete(key);
    }
  }
}

module.exports = { SlidingWindowCounter, InMemoryCounterStore };
