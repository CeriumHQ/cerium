import { describe, expect, it } from "@effect/vitest";

import { cueOfBatch, mayPlay, QUIET_MS } from "../src/desktop/sounds.ts";

describe("a thread's cue", () => {
  it("is one for a batch, the most important", () => {
    expect(cueOfBatch(["finished", "finished", "finished"])).toBe("finished");
    expect(cueOfBatch(["finished", "needsYou", "finished"])).toBe("needsYou");
    expect(cueOfBatch(["needsYou", "failed", "finished"])).toBe("failed");
    expect(cueOfBatch(["limit"])).toBeUndefined();
    expect(cueOfBatch([])).toBeUndefined();
  });
});

describe("the quiet after a sound", () => {
  const last = { cue: "needsYou" as const, at: 10_000 };

  it("lets the first sound play", () => {
    expect(mayPlay("finished", undefined, 0)).toBe(true);
  });

  it("holds back a sound of the same or lower importance while it lasts", () => {
    expect(mayPlay("needsYou", last, 10_000 + QUIET_MS - 1)).toBe(false);
    expect(mayPlay("finished", last, 10_000 + 100)).toBe(false);
  });

  it("lets a more important sound through, and any once it is over", () => {
    expect(mayPlay("failed", last, 10_000 + 100)).toBe(true);
    expect(mayPlay("finished", last, 10_000 + QUIET_MS)).toBe(true);
  });
});
