// node apps/ui/scripts/benchmark-transcript.ts [baseline=4a5ee17]
// Compare the actual split/layout functions from the audit baseline with today's functions.
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { performance } from "node:perf_hooks";
import { splitBlocks } from "../src/features/transcript/markdownBlocks.ts";
import { layout } from "../src/features/transcript/layout.ts";
import type { TranscriptBlock } from "../src/features/transcript/model.ts";

const baseline = process.argv[2] ?? "4a5ee17";
const historical = async (name: string) => {
  const path = `apps/ui/src/features/transcript/${name}.ts`;
  const source = stripTypeScriptTypes(
    execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }),
  );
  const original = new URL(`../src/features/transcript/${name}.ts`, import.meta.url);
  const resolved = source.replace(
    /from "([^"]+)"/g,
    (_all, specifier: string) =>
      `from ${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, original).href : import.meta.resolve(specifier))}`,
  );
  return import(`data:text/javascript;base64,${Buffer.from(resolved).toString("base64")}`);
};
const oldBlocks = (await historical("markdownBlocks")) as { splitBlocks: typeof splitBlocks };
const oldLayout = (await historical("layout")) as { layout: typeof layout };
for (const size of [100_000, 250_000]) {
  const run = (split: typeof splitBlocks) => {
    let text = `Fence benchmark ${size}.\n\n\`\`\`ts\n`;
    split(text);
    const times: number[] = [];
    while (text.length < size) {
      text += "const value = 123;\n".repeat(28);
      const start = performance.now();
      split(text);
      times.push(performance.now() - start);
    }
    return {
      bytes: text.length,
      batches: times.length,
      lastMs: times.at(-1),
      meanMs: times.reduce((sum, ms) => sum + ms, 0) / times.length,
    };
  };
  console.log(
    JSON.stringify({
      operation: "split appended fence",
      baseline,
      before: run(oldBlocks.splitBlocks),
      after: run(splitBlocks),
    }),
  );
}
for (const count of [5_000, 10_000]) {
  const calls: TranscriptBlock[] = Array.from({ length: count }, (_, i) => ({
    kind: "tool",
    id: `tool:${i}`,
    toolName: "Read",
    input: {},
    output: "ok",
    status: "done",
    changedFiles: [],
  }));
  const run = (arrange: typeof layout) => {
    for (let i = 0; i < 3; i++) arrange(calls);
    const start = performance.now();
    for (let i = 0; i < 10; i++) arrange(calls);
    return (performance.now() - start) / 10;
  };
  console.log(
    JSON.stringify({
      operation: "layout",
      calls: count,
      warmups: 3,
      samples: 10,
      baseline,
      beforeMeanMs: run(oldLayout.layout),
      afterMeanMs: run(layout),
    }),
  );
}
