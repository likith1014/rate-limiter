/**
 * Real-World Usage Demo
 * Run: node examples/demo.js
 */

const { TokenBucket } = require("../src/algorithms/token-bucket");
const { SlidingWindowLog } = require("../src/algorithms/sliding-window-log");
const { SlidingWindowCounter } = require("../src/algorithms/sliding-window-counter");
const { LeakyBucket } = require("../src/algorithms/leaky-bucket");
const { CompositeRateLimiter } = require("../src/algorithms/composite");
const { MonitoredLimiter } = require("../src/monitoring/metrics");

function separator(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function printResult(label, result) {
  const icon = result.allowed ? "✅" : "❌";
  const algo = result.algorithm || "composite";
  console.log(
    `${icon} ${label.padEnd(30)} remaining=${String(result.remaining).padStart(4)}  retryAfter=${result.retryAfter}s  [${algo}]`
  );
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {

  separator("1. GitHub-Style Public API Rate Limiting");
  const githubLimiter = new CompositeRateLimiter([
    { name: "per-minute", limiter: new SlidingWindowLog({ limit: 10, windowMs: 60_000 }) },
    { name: "per-hour",   limiter: new SlidingWindowCounter({ limit: 50, windowMs: 3_600_000 }) },
  ]);
  const monitored = new MonitoredLimiter(githubLimiter);
  console.log("\nSimulating burst of 12 API calls from unauthenticated user:");
  for (let i = 1; i <= 12; i++) {
    const result = await monitored.consume("github:anon:8.8.8.8");
    printResult(`Request #${i}`, result);
  }

  separator("2. Netflix-Style Streaming Rate Limiter (Leaky Bucket)");
  const streamingLimiter = new LeakyBucket({ capacity: 5, leakRate: 2 });
  console.log("\nSimulating client hammering video endpoint:");
  for (let i = 1; i <= 8; i++) {
    const result = await streamingLimiter.consume("netflix:stream:user-42");
    printResult(`Stream request #${i}`, result);
  }
  console.log("\nWaiting 3 seconds for bucket to drain...");
  await sleep(3000);
  const afterDrain = await streamingLimiter.consume("netflix:stream:user-42");
  printResult("Request after drain", afterDrain);

  separator("3. Stripe-Style Payment API (Token Bucket)");
  const paymentLimiter = new TokenBucket({ capacity: 10, refillRate: 2, refillInterval: 1000 });
  console.log("\nSimulating initial burst (legitimate batch payment processing):");
  for (let i = 1; i <= 12; i++) {
    const result = await paymentLimiter.consume("stripe:api-key:sk_live_xxx");
    printResult(`Payment request #${i}`, result);
  }
  console.log("\nWaiting 2 seconds for token refill...");
  await sleep(2000);
  console.log("\nAfter refill (4 tokens restored):");
  for (let i = 1; i <= 5; i++) {
    const result = await paymentLimiter.consume("stripe:api-key:sk_live_xxx");
    printResult(`Refilled request #${i}`, result);
  }

  separator("4. Weighted Requests — Endpoint-Aware Cost");
  const weightedLimiter = new SlidingWindowLog({ limit: 20, windowMs: 60_000 });
  const endpoints = [
    { name: "GET  /users",           cost: 1 },
    { name: "GET  /search?q=...",    cost: 3 },
    { name: "POST /export",          cost: 10 },
    { name: "GET  /profile",         cost: 1 },
    { name: "POST /report/generate", cost: 8 },
  ];
  console.log("\nMixed endpoint calls (budget: 20 tokens/minute):");
  for (const { name, cost } of endpoints) {
    const result = await weightedLimiter.consume("weighted:user-99", cost);
    printResult(`${name} (cost=${cost})`, result);
  }

  separator("5. Monitoring & Metrics");
  const metrics = monitored.getMetrics();
  console.log("\nLive Metrics Snapshot:");
  console.log(`  Total requests   : ${metrics.summary.totalRequests}`);
  console.log(`  Allowed          : ${metrics.summary.allowedRequests}`);
  console.log(`  Blocked          : ${metrics.summary.blockedRequests}`);
  console.log(`  Block rate       : ${metrics.summary.blockRatePercent}%`);
  console.log(`  Avg latency      : ${metrics.summary.avgDecisionLatencyMs}ms`);
  const prom = monitored.toPrometheusFormat();
  console.log("\n  Prometheus Output (snippet):");
  prom.split("\n").filter((l) => !l.startsWith("#") && l.trim()).forEach((l) => console.log(`    ${l}`));

  console.log("\n✅  Demo complete!\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
