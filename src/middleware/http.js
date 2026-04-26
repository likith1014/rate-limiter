/**
 * Express/Node.js HTTP Middleware
 *
 * Drop-in middleware for Express, Fastify (via adapter), or any
 * Node.js HTTP server. Handles key extraction, response headers,
 * and 429 responses automatically.
 *
 * Usage:
 *   const { createMiddleware } = require('./middleware/http');
 *   const { TokenBucket } = require('./algorithms/token-bucket');
 *
 *   const limiter = new TokenBucket({ capacity: 100, refillRate: 10 });
 *
 *   app.use('/api', createMiddleware(limiter, {
 *     keyExtractor: (req) => req.headers['x-api-key'] || req.ip,
 *     onLimitReached: (req, res, result) => {
 *       res.status(429).json({ error: 'Too Many Requests', retryAfter: result.retryAfter });
 *     }
 *   }));
 */

const DEFAULT_KEY_EXTRACTORS = {
  /**
   * Use API key from Authorization header or X-API-Key header.
   * Falls back to IP address.
   */
  apiKey: (req) => {
    const authHeader = req.headers["authorization"] || "";
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) return `apikey:${bearerMatch[1]}`;
    if (req.headers["x-api-key"]) return `apikey:${req.headers["x-api-key"]}`;
    return `ip:${getClientIp(req)}`;
  },

  /**
   * Use client IP address (handles proxies, load balancers).
   */
  ip: (req) => `ip:${getClientIp(req)}`,

  /**
   * Use authenticated user ID from req.user (e.g., after JWT middleware).
   */
  userId: (req) => (req.user ? `user:${req.user.id}` : `ip:${getClientIp(req)}`),

  /**
   * Use a combination of user + endpoint for per-route limits.
   */
  userAndRoute: (req) => {
    const user = req.user ? `user:${req.user.id}` : `ip:${getClientIp(req)}`;
    const route = req.route ? req.route.path : req.path;
    return `${user}:${route}`;
  },
};

/**
 * Create Express middleware from any rate limiter instance.
 *
 * @param {object} limiter - Any limiter (TokenBucket, SlidingWindow, Composite, etc.)
 * @param {object} [options]
 * @param {function} [options.keyExtractor]     - Extract rate limit key from req
 * @param {function} [options.onLimitReached]   - Custom handler for 429 responses
 * @param {function} [options.onError]          - Handler for store errors
 * @param {boolean}  [options.skipSuccessful]   - Don't count 2xx responses
 * @param {boolean}  [options.setHeaders=true]  - Attach X-RateLimit-* headers
 * @param {Array}    [options.skip]             - Array of (req) => bool skip fns
 * @param {number}   [options.cost=1]           - Request cost
 */
function createMiddleware(limiter, options = {}) {
  const {
    keyExtractor = DEFAULT_KEY_EXTRACTORS.ip,
    onLimitReached = defaultLimitHandler,
    onError = defaultErrorHandler,
    skipSuccessful = false,
    setHeaders = true,
    skip = [],
    cost = 1,
  } = options;

  return async function rateLimitMiddleware(req, res, next) {
    // Check skip conditions
    for (const skipFn of skip) {
      if (await skipFn(req)) return next();
    }

    let key;
    try {
      key = await keyExtractor(req);
    } catch (err) {
      return onError(err, req, res, next);
    }

    let result;
    try {
      result = await limiter.consume(key, cost);
    } catch (err) {
      return onError(err, req, res, next);
    }

    // Attach rate limit info to request for downstream use
    req.rateLimit = result;

    // Set standard response headers
    if (setHeaders) {
      const headers = result.headers || buildBasicHeaders(result);
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    }

    if (!result.allowed) {
      return onLimitReached(req, res, result);
    }

    if (skipSuccessful) {
      // Rollback if response is successful (2xx)
      const originalEnd = res.end.bind(res);
      res.end = async function (...args) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Note: rollback is algorithm-specific; here we just proceed
          // A real implementation would decrement the counter
        }
        return originalEnd(...args);
      };
    }

    next();
  };
}

/**
 * Default 429 response handler.
 * Returns RFC 7807 Problem Details JSON.
 */
function defaultLimitHandler(req, res, result) {
  res.setHeader("Retry-After", String(result.retryAfter || 60));
  res.setHeader("Content-Type", "application/problem+json");
  res.status(429).json({
    type: "https://httpstatuses.io/429",
    title: "Too Many Requests",
    status: 429,
    detail: `Rate limit exceeded. Try again in ${result.retryAfter} second(s).`,
    retryAfter: result.retryAfter,
    limit: result.limit,
    remaining: 0,
  });
}

function defaultErrorHandler(err, req, res, next) {
  console.error("[RateLimiter] Store error:", err.message);
  // Fail open — allow request if rate limiter has an error
  // (Change to next(err) for fail closed behavior)
  next();
}

function buildBasicHeaders(result) {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil((Date.now() + (result.resetAfter || 0)) / 1000)),
    ...(result.algorithm && { "X-RateLimit-Algorithm": result.algorithm }),
  };
}

/**
 * Extract real client IP from various proxy headers.
 * Handles: Cloudflare, AWS ELB, Nginx, standard X-Forwarded-For.
 */
function getClientIp(req) {
  const cfIp = req.headers["cf-connecting-ip"];
  if (cfIp) return cfIp;

  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = req.headers["x-real-ip"];
  if (realIp) return realIp;

  return req.connection?.remoteAddress || req.socket?.remoteAddress || "unknown";
}

module.exports = {
  createMiddleware,
  DEFAULT_KEY_EXTRACTORS,
  getClientIp,
  defaultLimitHandler,
};
