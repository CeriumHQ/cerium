import { describe, expect, it } from "@effect/vitest";
import { PREVIEW_IDLE_MS, releasablePreviews, type PreviewUsage } from "../src/previewRetention.ts";

const page = (threadId: string, changes: Partial<PreviewUsage> = {}): PreviewUsage => ({
  threadId,
  shown: false,
  active: false,
  calls: 0,
  lastUsed: 1000,
  parkedUntil: 0,
  retired: false,
  ...changes,
});

describe("preview retention", () => {
  it("releases archived pages, but waits for their agent and browser calls to finish", () => {
    const retired = { retired: true, shown: true };
    expect(
      releasablePreviews(
        [
          page("archived", retired),
          page("agent", { ...retired, active: true }),
          page("call", { ...retired, calls: 1 }),
        ],
        2000,
      ),
    ).toEqual(["archived"]);
  });
  it("keeps visible and agent-owned pages across long pauses between calls", () => {
    expect(
      releasablePreviews(
        [
          page("visible", { shown: true }),
          page("agent", { active: true }),
          page("call", { calls: 1 }),
          page("idle"),
        ],
        PREVIEW_IDLE_MS + 2000,
      ),
    ).toEqual(["idle"]);
  });
  it("bounds warm hidden pages by recency and leaves an agent's screenshot grace alone", () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(String(i), { lastUsed: i * 100 }));
    expect(releasablePreviews([...pages, page("parked", { parkedUntil: 3000 })], 2000)).toEqual([
      "5",
      "4",
      "3",
      "2",
      "1",
      "0",
    ]);
  });
});
