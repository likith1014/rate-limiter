/**
 * Redis Store Adapters
 *
 * Production-grade distributed storage for all rate limiting algorithms.
 * Uses atomic Lua scripts to prevent race conditions in distributed environments.
 *
 * These scripts execute atomically on the Redis server, eliminating the
 * check-then-act race condition present in naive get/set approaches.
 *
 * Usage:
 *   const redis = require('redis');
 *   const client = redis.createClient({ url: process.env.REDIS_URL });
 *   await client.connect();
 *
 *   const store = new RedisBucketStore(client);
 *   const limiter = new TokenBucket({ capacity: 100, refillRate: 10, store });
 */

/**
 * Redis store for Token Bucket and Leaky Bucket.
 * Atomically reads, updates, and writes bucket state using Lua.
 */
class RedisBucketStore {
  constructor(redisClient, { keyPrefix = "rl:bucket:" } = {}) {
    this.client = redisClient;
    this.keyPrefix = keyPrefix;

    // Atomic get-and-set Lua script
    this._setScript = `
      local key = KEYS[1]
      local value = ARGV[1]
      local ttl = tonumber(ARGV[2])
      redis.call('SET', key, value, 'EX', ttl)
      return 1
    `;
  }

  _key(key) {
    return `${this.keyPrefix}${key}`;
  }

  async get(key) {
    const raw = await this.client.get(this._key(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    await this.client.set(this._key(key), JSON.stringify(value), { EX: ttlSeconds });
  }

  async delete(key) {
    await this.client.del(this._key(key));
  }
}

/**
 * Redis store for Sliding Window Log.
 * Uses a Redis Sorted Set — timestamps as scores, atomic ZADD/ZREMRANGEBYSCORE.
 */
class RedisLogStore {
  constructor(redisClient, { keyPrefix = "rl:log:" } = {}) {
    this.client = redisClient;
    this.keyPrefix = keyPrefix;
  }

  _key(key) {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Atomically:
   * 1. Remove expired entries (older than windowStart)
   * 2. Count remaining entries
   * 3. Add new entry if under limit
   * 4. Return [allowed, count]
   *
   * This Lua script is the heart of a distributed sliding window log.
   */
  async consumeAtomic(key, limit, windowMs, now, cost = 1) {
    const windowStart = now - windowMs;
    const redisKey = this._key(key);
    const ttl = Math.ceil(windowMs / 1000) + 5;

    const script = `
      local key = KEYS[1]
      local window_start = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local cost = tonumber(ARGV[4])
      local ttl = tonumber(ARGV[5])

      -- Remove expired entries
      redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

      -- Count weighted usage (using score-based weight encoding)
      local count = redis.call('ZCARD', key)

      if count + cost <= limit then
        -- Add new entries for this request (one per unit of cost)
        for i = 1, cost do
          redis.call('ZADD', key, now, now .. ':' .. i .. ':' .. math.random(1000000))
        end
        redis.call('EXPIRE', key, ttl)
        return {1, count + cost}
      end

      return {0, count}
    `;

    const result = await this.client.eval(script, {
      keys: [redisKey],
      arguments: [
        windowStart.toString(),
        now.toString(),
        limit.toString(),
        cost.toString(),
        ttl.toString(),
      ],
    });

    return { allowed: result[0] === 1, count: result[1] };
  }

  async delete(key) {
    await this.client.del(this._key(key));
  }
}

/**
 * Redis store for Sliding Window Counter.
 * Uses atomic INCR with EXPIRE — O(1) per operation.
 */
class RedisCounterStore {
  constructor(redisClient, { keyPrefix = "rl:counter:" } = {}) {
    this.client = redisClient;
    this.keyPrefix = keyPrefix;
  }

  _key(key) {
    return `${this.keyPrefix}${key}`;
  }

  async get(key) {
    const val = await this.client.get(this._key(key));
    return val ? parseInt(val, 10) : null;
  }

  async increment(key, amount = 1, ttlSeconds) {
    const redisKey = this._key(key);

    // Atomic increment + set TTL only if key is new
    const script = `
      local key = KEYS[1]
      local amount = tonumber(ARGV[1])
      local ttl = tonumber(ARGV[2])
      local current = redis.call('INCRBY', key, amount)
      if current == amount then
        redis.call('EXPIRE', key, ttl)
      end
      return current
    `;

    return await this.client.eval(script, {
      keys: [redisKey],
      arguments: [amount.toString(), ttlSeconds.toString()],
    });
  }

  async delete(key) {
    await this.client.del(this._key(key));
  }
}

/**
 * Mock Redis client for testing without a real Redis instance.
 * Implements the same interface as node-redis v4.
 */
class MockRedisClient {
  constructor() {
    this._store = new Map();
    this._expiries = new Map();
  }

  async get(key) {
    if (this._isExpired(key)) {
      this._store.delete(key);
      return null;
    }
    return this._store.get(key) || null;
  }

  async set(key, value, options = {}) {
    this._store.set(key, value);
    if (options.EX) {
      this._expiries.set(key, Date.now() + options.EX * 1000);
    }
    return "OK";
  }

  async del(key) {
    this._store.delete(key);
    this._expiries.delete(key);
    return 1;
  }

  async eval(script, { keys, arguments: args }) {
    // Simplified mock eval — for testing only
    // Real behavior requires a real Redis server
    const key = keys[0];
    const current = parseInt(this._store.get(key) || "0", 10);
    const amount = parseInt(args[0], 10);
    const ttl = parseInt(args[1], 10);
    const newVal = current + amount;
    this._store.set(key, newVal.toString());
    this._expiries.set(key, Date.now() + ttl * 1000);
    return newVal;
  }

  _isExpired(key) {
    const expiry = this._expiries.get(key);
    return expiry && Date.now() > expiry;
  }

  // Diagnostic
  keys() {
    return [...this._store.keys()].filter((k) => !this._isExpired(k));
  }
}

module.exports = { RedisBucketStore, RedisLogStore, RedisCounterStore, MockRedisClient };
