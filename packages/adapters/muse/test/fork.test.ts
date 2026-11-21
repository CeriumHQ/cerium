import { describe, expect, it } from "@effect/vitest";
import type { Item } from "@muse-code/sdk/dist/src/msp.js";

import { museForkBoundary } from "../src/fork.ts";

const item = (turnId: string, options: Partial<Item> = {}): Item => ({
  itemId: turnId,
  kind: "userMessage",
  turnId,
  status: "completed",
  revision: 1,
  ...options,
});

describe("Muse fork boundary", () => {
  const history = [
    item("t1"),
    item("t1", { kind: "agentMessage" }),
    item("discarded", { retracted: true }),
    item("t2"),
  ];

  it("keeps the native turn through the requested point", () => {
    expect(museForkBoundary(history, { through: { id: "t2", index: 0 } })).toBe("t2");
    expect(museForkBoundary(history, { through: { index: 1 } })).toBe("t2");
  });

  it("rewinds to the previous turn and distinguishes an empty prefix from an unknown turn", () => {
    expect(museForkBoundary(history, { before: { index: 1 } })).toBe("t1");
    expect(museForkBoundary(history, { before: { index: 0 } })).toBeNull();
    expect(museForkBoundary(history, { before: { index: 2 } })).toBeUndefined();
  });
});
