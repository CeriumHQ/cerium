// node packages/orchestrator/scripts/benchmark-overviews.ts [threads=1000]
import type { ThreadOverview } from "@cerium/protocol";
import { performance } from "node:perf_hooks";
import { overviewDiff } from "../src/overviewWatch.ts";

const count = Number(process.argv[2] ?? 1000);
const before = Array.from({ length: count }, (_, i) => ({
  thread: { id: `thread_${i}`, title: `Thread ${i}`, mode: "work", createdAt: i, updatedAt: i },
  agents: [
    {
      id: `agent_${i}`,
      threadId: `thread_${i}`,
      role: "lead",
      provider: "claude",
      model: "claude-opus-5-5",
      access: "ask",
      state: "idle",
      createdAt: i,
      updatedAt: i,
    },
  ],
  awaitingApproval: false,
})) as ReadonlyArray<ThreadOverview>;
const after = before.map((row, i) =>
  i === 500 ? { ...row, thread: { ...row.thread, title: "Renamed" } } : row,
);
const measure = (read: () => string) => {
  for (let i = 0; i < 20; i++) read();
  const start = performance.now();
  let bytes = 0;
  for (let i = 0; i < 100; i++) bytes = Buffer.byteLength(read());
  return { bytes, meanMs: (performance.now() - start) / 100 };
};
const full = measure(() => JSON.stringify(after));
const patch = measure(() => JSON.stringify({ _tag: "Patch", revision: 1, ...overviewDiff(before, after) }));
console.log(JSON.stringify({ threads: count, full, patch }, null, 2));
