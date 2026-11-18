import { describe, expect, it } from "@effect/vitest";

import { createHighlightWorker } from "../src/features/viewer/highlightEngine.ts";
import type { HighlightResponse } from "../src/features/viewer/highlight.ts";

function worker() {
  const responses = new Map<number, (response: HighlightResponse) => void>();
  const order: Array<number> = [];
  const send = createHighlightWorker((response) => {
    order.push(response.id);
    responses.get(response.id)?.(response);
  });
  return {
    order,
    send,
    open: (document: number, text: string) => send({ type: "open", document, path: "a.ts", text }),
    range: (id: number, document: number, first: number, end: number) =>
      new Promise<HighlightResponse>((resolve) => {
        responses.set(id, resolve);
        send({ type: "range", id, document, first, end });
      }),
  };
}

describe("viewer highlighting", () => {
  it("starts a distant chunk in the grammar state of the preceding lines", async () => {
    const { open, range } = worker();
    open(1, ["/*", ...Array<string>(250).fill("comment"), "*/", "const x = 1;", ""].join("\r\n"));
    const { lines } = await range(1, 1, 250, 254);
    expect(lines).toHaveLength(4);
    expect(lines?.[0]?.[0]).toEqual(["comment", "var(--shiki-token-comment)"]);
    expect(lines?.[2]?.[0]).toEqual(["const", "var(--shiki-token-keyword)"]);
    expect(lines?.[3]).toEqual([]);
    // Moving back through the document still starts in the right state.
    expect((await range(2, 1, 100, 101)).lines?.[0]?.[0]).toEqual(lines?.[0]?.[0]);
  });

  it("gives another visible range a turn while scanning a distant range's prefix", async () => {
    const { open, range, order } = worker();
    open(1, ["/*", ...Array<string>(400).fill("comment")].join("\n"));
    open(2, "const x = 1;");
    const distant = range(1, 1, 400, 401);
    const nearby = range(2, 2, 0, 1);
    expect((await nearby).lines?.[0]?.[0]).toEqual(["const", "var(--shiki-token-keyword)"]);
    expect((await distant).lines?.[0]?.[0]).toEqual(["comment", "var(--shiki-token-comment)"]);
    expect(order).toEqual([2, 1]);
  });

  it("drops canceled work and leaves oversized lines plain without losing their surrounding state", async () => {
    const { open, range, send, order } = worker();
    open(1, ["/*", "x".repeat(4_000), ...Array<string>(400).fill("comment"), "*/"].join("\n"));
    void range(1, 1, 400, 401);
    const { lines } = await range(2, 1, 1, 3);
    send({ type: "cancel", id: 1 });
    expect(lines).toEqual([undefined, [["comment", "var(--shiki-token-comment)"]]]);
    // A fresh, longer prefix gives the canceled request enough time to finish if it is still queued.
    open(2, Array<string>(601).fill("const x = 1;").join("\n"));
    await range(3, 2, 600, 601);
    expect(order).toEqual([2, 3]);
  });
});
