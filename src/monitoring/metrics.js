/**
 * Rate Limiter Monitoring & Metrics
 *
 * Wraps any rate limiter to capture real-time metrics:
 *   - Request throughput (allowed vs blocked)
 *   - Block rate per key / algorithm
 *   - Latency of limiter decisions
 *   - Top consumers (who is hitting limits most)
 *
 * Designed to emit to Prometheus, Datadog StatsD, or any custom sink.
 * At Google/Netflix scale, these metrics feed alerting dashboards.
 *
 * Usage:
 *   const monitored = new MonitoredLimiter(limiter, {
 *     onMetric: (metric) => statsd.increment(metric.name, metric.tags),
 *   });
 */

class MonitoredLimiter {
  constructor(limiter, options = {}) {
    this.limiter = limiter;
    this.options = options;
    this._metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      totalLatencyMs: 0,
      topConsumers: new Map(), // key -> { allowed, blocked }
      blocksByAlgorithm: new Map(),
      recentDecisions: [], // circular buffer, last 1000
    };
    this._maxRecentDecisions = options.recentDecisionsBuffer || 1000;
  }

  async consume(key, cost = 1) {
    const start = Date.now();
    let result;

    try {
      result = await this.limiter.consume(key, cost);
    } catch (err) {
      this._emit("rate_limiter.error", { key, error: err.message });
      throw err;
    }

    const latencyMs = Date.now() - start;
    this._record(key, result, latencyMs);

    return result;
  }

  async reset(key) {
    return this.limiter.reset(key);
  }

  async status(key) {
    return this.limiter.status ? this.limiter.status(key) : null;
  }

  _record(key, result, latencyMs) {
    const m = this._metrics;
    m.totalRequests++;
    m.totalLatencyMs += latencyMs;

    if (result.allowed) {
      m.allowedRequests++;
    } else {
      m.blockedRequests++;
    }

    // Track per-key consumption
    if (!m.topConsumers.has(key)) {
      m.topConsumers.set(key, { allowed: 0, blocked: 0, totalCost: 0 });
    }
    const consumer = m.topConsumers.get(key);
    result.allowed ? consumer.allowed++ : consumer.blocked++;
    consumer.totalCost++;

    // Track per-algorithm blocks
    if (!result.allowed && result.algorithm) {
      const algo = result.algorithm;
      m.blocksByAlgorithm.set(algo, (m.blocksByAlgorithm.get(algo) || 0) + 1);
    }

    // Circular buffer of recent decisions
    m.recentDecisions.push({
      ts: Date.now(),
      key,
      allowed: result.allowed,
      remaining: result.remaining,
      latencyMs,
      algorithm: result.algorithm,
    });
    if (m.recentDecisions.length > this._maxRecentDecisions) {
      m.recentDecisions.shift();
    }

    // Emit individual metric
    this._emit("rate_limiter.decision", {
      key,
      allowed: result.allowed,
      latencyMs,
      algorithm: result.algorithm,
      remaining: result.remaining,
    });

    if (!result.allowed) {
      this._emit("rate_limiter.blocked", { key, algorithm: result.algorithm });
    }
  }

  _emit(name, tags = {}) {
    if (this.options.onMetric) {
      try {
        this.options.onMetric({ name, tags, ts: Date.now() });
      } catch {}
    }
  }

  /**
   * Get a snapshot of all collected metrics.
   */
  getMetrics() {
    const m = this._metrics;
    const blockRate =
      m.totalRequests > 0 ? ((m.blockedRequests / m.totalRequests) * 100).toFixed(2) : "0.00";
    const avgLatency =
      m.totalRequests > 0 ? (m.totalLatencyMs / m.totalRequests).toFixed(2) : "0.00";

    // Top 10 consumers by total requests
    const topConsumers = [...m.topConsumers.entries()]
      .map(([key, stats]) => ({ key, ...stats }))
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 10);

    // Top blocked consumers
    const topBlocked = [...m.topConsumers.entries()]
      .map(([key, stats]) => ({ key, ...stats }))
      .filter((c) => c.blocked > 0)
      .sort((a, b) => b.blocked - a.blocked)
      .slice(0, 10);

    return {
      summary: {
        totalRequests: m.totalRequests,
        allowedRequests: m.allowedRequests,
        blockedRequests: m.blockedRequests,
        blockRatePercent: parseFloat(blockRate),
        avgDecisionLatencyMs: parseFloat(avgLatency),
      },
      topConsumers,
      topBlocked,
      blocksByAlgorithm: Object.fromEntries(m.blocksByAlgorithm),
      recentDecisions: m.recentDecisions.slice(-50), // Last 50
    };
  }

  /**
   * Reset all metrics (e.g., on interval for windowed stats).
   */
  resetMetrics() {
    this._metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      totalLatencyMs: 0,
      topConsumers: new Map(),
      blocksByAlgorithm: new Map(),
      recentDecisions: [],
    };
  }

  /**
   * Generate a Prometheus-compatible metrics text string.
   * Mount this at GET /metrics for scraping.
   */
  toPrometheusFormat() {
    const m = this.getMetrics();
    const lines = [
      `# HELP rate_limiter_requests_total Total rate limiter decisions`,
      `# TYPE rate_limiter_requests_total counter`,
      `rate_limiter_requests_total{status="allowed"} ${m.summary.allowedRequests}`,
      `rate_limiter_requests_total{status="blocked"} ${m.summary.blockedRequests}`,
      ``,
      `# HELP rate_limiter_decision_latency_ms Average decision latency in ms`,
      `# TYPE rate_limiter_decision_latency_ms gauge`,
      `rate_limiter_decision_latency_ms ${m.summary.avgDecisionLatencyMs}`,
      ``,
      `# HELP rate_limiter_block_rate_percent Percentage of requests blocked`,
      `# TYPE rate_limiter_block_rate_percent gauge`,
      `rate_limiter_block_rate_percent ${m.summary.blockRatePercent}`,
    ];

    for (const [algo, count] of Object.entries(m.blocksByAlgorithm)) {
      lines.push(
        `rate_limiter_blocks_by_algorithm{algorithm="${algo}"} ${count}`
      );
    }

    return lines.join("\n");
  }
}

module.exports = { MonitoredLimiter };
