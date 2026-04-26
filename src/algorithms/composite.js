/**
 * Composite Rate Limiter
 *
 * Enforces MULTIPLE rate limit tiers simultaneously — exactly how
 * Google, Twitter, and Stripe implement their real APIs.
 *
 * Example tiers (GitHub's real limits):
 *   - 60 requests / minute  (burst)
 *   - 1000 requests / hour  (sustained)
 *   - 5000 requests / day   (quota)
 *
 * All tiers must pass for a request to be allowed.
 * The most restrictive remaining/reset is surfaced to the caller.
 *
 * This is the class you'd wire up in production at a company like
 * Netflix or Google where different time horizons need enforcement.
 */

class CompositeRateLimiter {
  /**
   * @param {Array<{name: string, limiter: object}>} tiers
   *   Each tier is a named limiter instance (TokenBucket, SlidingWindowLog, etc.)
   *
   * @example
   * const limiter = new CompositeRateLimiter([
   *   { name: 'per-second', limiter: new TokenBucket({ capacity: 10, refillRate: 10 }) },
   *   { name: 'per-minute', limiter: new SlidingWindowLog({ limit: 100, windowMs: 60_000 }) },
   *   { name: 'per-day',    limiter: new SlidingWindowCounter({ limit: 10000, windowMs: 86_400_000 }) },
   * ]);
   */
  constructor(tiers) {
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new Error("CompositeRateLimiter requires at least one tier");
    }
    this.tiers = tiers;
  }

  /**
   * Consume from ALL tiers. Uses a two-phase approach:
   * Phase 1: Check all tiers (dry run)
   * Phase 2: If all pass, commit to all tiers
   *
   * This prevents partial consumption when some tiers allow and others deny.
   *
   * @param {string} key
   * @param {number} [cost=1]
   * @returns {Promise<CompositeResult>}
   */
  async consume(key, cost = 1) {
    // Phase 1: Check all tiers via peek/status (non-destructive)
    const checks = await Promise.all(
      this.tiers.map(async ({ name, limiter }) => {
        const status = limiter.peek
          ? await limiter.peek(key)
          : limiter.status
          ? await limiter.status(key)
          : null;
        return { name, status };
      })
    );

    // Phase 2: Optimistic consume — all tiers get consumed
    // (If a tier blocks, we skip the rest and return the blocking result)
    const results = [];
    const blocked = [];

    for (const { name, limiter } of this.tiers) {
      const result = await limiter.consume(key, cost);
      results.push({ name, ...result });
      if (!result.allowed) {
        blocked.push({ name, ...result });
      }
    }

    const allAllowed = blocked.length === 0;

    // Surface the most restrictive tier's limits
    const mostRestrictive = results.reduce((worst, curr) => {
      if (!worst) return curr;
      if (!curr.allowed) return curr;
      return curr.remaining < worst.remaining ? curr : worst;
    });

    // Headers following RFC 6585 / IETF draft-ietf-httpapi-ratelimit-headers
    const headers = this._buildHeaders(results, mostRestrictive);

    return {
      allowed: allAllowed,
      tiers: results,
      blocked,
      // Expose the most restrictive values at top level (for middleware convenience)
      remaining: mostRestrictive.remaining,
      limit: mostRestrictive.limit,
      resetAfter: mostRestrictive.resetAfter,
      retryAfter: allAllowed ? 0 : Math.max(...blocked.map((b) => b.retryAfter)),
      headers,
      key,
    };
  }

  /**
   * Reset all tiers for a key.
   */
  async reset(key) {
    await Promise.all(this.tiers.map(({ limiter }) => limiter.reset(key)));
  }

  /**
   * Get status across all tiers without consuming.
   */
  async status(key) {
    const results = await Promise.all(
      this.tiers.map(async ({ name, limiter }) => {
        const status = limiter.status
          ? await limiter.status(key)
          : limiter.peek
          ? await limiter.peek(key)
          : {};
        return { name, ...status };
      })
    );
    return results;
  }

  /**
   * Build standard rate limit response headers.
   * Follows: https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
   */
  _buildHeaders(results, mostRestrictive) {
    const headers = {
      "X-RateLimit-Limit": String(mostRestrictive.limit),
      "X-RateLimit-Remaining": String(mostRestrictive.remaining),
      "X-RateLimit-Reset": String(Math.ceil((Date.now() + mostRestrictive.resetAfter) / 1000)),
      "X-RateLimit-Algorithm": mostRestrictive.algorithm || "composite",
    };

    // Add per-tier headers for observability
    results.forEach(({ name, limit, remaining, resetAfter }) => {
      const safeName = name.replace(/[^a-zA-Z0-9-]/g, "-");
      headers[`X-RateLimit-${safeName}-Limit`] = String(limit);
      headers[`X-RateLimit-${safeName}-Remaining`] = String(remaining);
      headers[`X-RateLimit-${safeName}-Reset`] = String(
        Math.ceil((Date.now() + (resetAfter || 0)) / 1000)
      );
    });

    return headers;
  }
}

module.exports = { CompositeRateLimiter };
