/**
 * Sliding Window Log Algorithm
 *
 * Used by: GitHub API, Cloudflare, Kong Gateway
 *
 * Concept: Maintain a log of timestamps for each request. On each new request,
 * discard all timestamps older than the window, then count what remains.
 * If count < limit, allow and log the new timestamp.
 *
 * Strengths:
 *  - Perfectly accurate — no boundary edge issues
 *  - No burst spikes at window boundaries
 *
 * Weaknesses:
 *  - Higher memory usage (stores one timestamp per request)
 *  - Slightly more expensive per-request than counter approaches
 *
 * Best for: Strict per-user limits (GitHub: 5000 req/hr)
 */

class SlidingWindowLog {
  /**
   * @param {Object} options
   * @param {number} options.limit        - Max requests per window
   * @param {number} options.windowMs     - Window size in milliseconds
   * @param {Object} [options.store]      - Pluggable store
   */
  constructor({ limit, windowMs, store = null }) {
    if (!limit || limit <= 0) throw new Error("limit must be a positive number");
    if (!windowMs || windowMs <= 0) throw new Error("windowMs must be a positive number");

    this.limit = limit;
    this.windowMs = windowMs;
    this.store = store || new InMemoryLogStore();
  }

  /**
   * Attempt to record a request for the given key.
   *
   * @param {string} key
   * @param {number} [cost=1] - Request weight (for weighted rate limiting)
   * @returns {Promise<RateLimitResult>}
   */
  async consume(key, cost = 1) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let log = await this.store.get(key) || [];

    // Evict expired entries
    log = log.filter((entry) => entry.ts > windowStart);

    // Count weighted usage
    const usedWeight = log.reduce((sum, e) => sum + (e.weight || 1), 0);
    const allowed = usedWeight + cost <= this.limit;

    if (allowed) {
      log.push({ ts: now, weight: cost });
      await this.store.set(key, log, Math.ceil(this.windowMs / 1000) + 5);
    }

    const remaining = Math.max(0, this.limit - usedWeight - (allowed ? cost : 0));

    // Time until oldest entry expires (= when a slot opens up)
    const oldestTs = log.length > 0 ? log[0].ts : now;
    const resetAfter = allowed ? 0 : Math.max(0, oldestTs + this.windowMs - now);

    return {
      allowed,
      remaining,
      limit: this.limit,
      resetAfter,
      retryAfter: allowed ? 0 : Math.ceil(resetAfter / 1000),
      algorithm: "sliding-window-log",
      key,
      windowMs: this.windowMs,
      currentCount: usedWeight + (allowed ? cost : 0),
    };
  }

  /**
   * Get current window usage without consuming.
   */
  async status(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const log = (await this.store.get(key) || []).filter((e) => e.ts > windowStart);
    const used = log.reduce((sum, e) => sum + (e.weight || 1), 0);
    return {
      used,
      remaining: Math.max(0, this.limit - used),
      limit: this.limit,
      entriesInWindow: log.length,
    };
  }

  async reset(key) {
    await this.store.delete(key);
  }
}

class InMemoryLogStore {
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

  memoryUsage() {
    let entries = 0;
    for (const log of this._data.values()) entries += log.length;
    return { keys: this._data.size, totalEntries: entries };
  }
}

module.exports = { SlidingWindowLog, InMemoryLogStore };
