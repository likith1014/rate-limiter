const { TokenBucket } = require("../src/algorithms/token-bucket");
const { SlidingWindowLog } = require("../src/algorithms/sliding-window-log");
const { SlidingWindowCounter } = require("../src/algorithms/sliding-window-counter");
const { LeakyBucket } = require("../src/algorithms/leaky-bucket");

const ITERATIONS = 5000;

async function benchmark(name, limiterFactory) {
  const limiter = limiterFactory();
  const start = Date.now();
  let allowed = 0, blocked = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const key = `user-${i % 100}`;
    const result = await limiter.consume(key);
    result.allowed ? allowed++ : blocked++;
  }
  const elapsed = Date.now() - start;
  return { name, opsPerSec: Math.round(ITERATIONS / (elapsed / 1000)), avgLatency: (elapsed / ITERATIONS).toFixed(3), allowed, blocked };
}

async function main() {
  console.log(`\n⚡ Rate Limiter Benchmark — ${ITERATIONS.toLocaleString()} requests across 100 keys\n`);
  console.log("─".repeat(70));
  const results = [];
  results.push(await benchmark("Token Bucket", () => new TokenBucket({ capacity: 100, refillRate: 50 })));
  results.push(await benchmark("Sliding Window Log", () => new SlidingWindowLog({ limit: 100, windowMs: 5000 })));
  results.push(await benchmark("Sliding Window Counter", () => new SlidingWindowCounter({ limit: 100, windowMs: 5000 })));
  results.push(await benchmark("Leaky Bucket", () => new LeakyBucket({ capacity: 100, leakRate: 50 })));
  console.log(`${"Algorithm".padEnd(28)} ${"ops/sec".padStart(10)} ${"avg ms".padStart(8)} ${"allowed".padStart(8)} ${"blocked".padStart(8)}`);
  console.log("─".repeat(70));
  results.forEach(({ name, opsPerSec, avgLatency, allowed, blocked }) => {
    console.log(`${name.padEnd(28)} ${opsPerSec.toLocaleString().padStart(10)} ${avgLatency.padStart(8)} ${allowed.toLocaleString().padStart(8)} ${blocked.toLocaleString().padStart(8)}`);
  });
  console.log("─".repeat(70));
  console.log("\nNote: All algorithms use in-memory stores.");
  console.log("Redis store adds ~1-3ms network latency per operation.\n");
}

main().catch((err) => { console.error(err); process.exit(1); });
