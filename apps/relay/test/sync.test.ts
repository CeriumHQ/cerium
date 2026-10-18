import { describe, expect, it } from "@effect/vitest";

import { appendBatch } from "../src/sync.ts";

describe("appending a batch to the cloud copy", () => {
  it("keeps a batch that follows on from what the cloud has", () => {
    expect(appendBatch(3, 3, ["d", "e"])).toEqual({ keep: ["d", "e"], count: 5 });
    expect(appendBatch(0, 0, ["a"])).toEqual({ keep: ["a"], count: 1 });
  });

  it("trims what the cloud already has from a batch sent again", () => {
    expect(appendBatch(5, 3, ["d", "e", "f"])).toEqual({ keep: ["f"], count: 6 });
    expect(appendBatch(5, 3, ["d", "e"])).toEqual({ keep: [], count: 5 });
  });

  it("keeps nothing from a batch past a gap, so the machine resends from what the cloud has", () => {
    expect(appendBatch(2, 4, ["e", "f"])).toEqual({ keep: [], count: 2 });
  });
});
