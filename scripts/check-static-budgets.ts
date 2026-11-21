// Run both checks to completion so the latency budget never conceals lint or format findings.
// The original 1.4.3 pin has no native formatter. The 1.4.4 rollout uses the same Vite+ config.
import { spawnSync } from "node:child_process";

const format = Bun.version === "1.4.3" ? ["run", "vp", "fmt", "--check"] : ["fmt", "--check"];
for (const [label, args] of [
  ["Format", format],
  ["Lint", ["run", "vp", "check", "--no-fmt"]],
] as const) {
  const start = performance.now();
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  const elapsed = performance.now() - start;
  console.log(`${label} took ${Math.round(elapsed)} ms (budget <1000 ms)`);
  if (result.error) console.error(result.error.message);
  if (result.status !== 0 || elapsed >= 1000) process.exitCode = 1;
}
