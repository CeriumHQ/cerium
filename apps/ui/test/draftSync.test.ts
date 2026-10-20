import type { DraftEntry } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import type { Draft } from "../src/features/composer/draft.ts";
import { fingerprint, keptDraft, stampChanges, type Drafts } from "../src/features/composer/drafts.ts";
import { applyTaken, draftBatches, reconcileDrafts } from "../src/features/composer/draftSync.ts";

const written = (value: string, start?: Draft["start"]): Draft => ({
  segments: [{ kind: "text", text: value }],
  attachments: [],
  ...(start ? { start } : {}),
});

const stampOf = (draft: Draft | undefined, at: number) => ({ at, hash: fingerprint(keptDraft(draft)) });

/** What a draft with something in it shares. */
const shared = (draft: Draft | undefined) => keptDraft(draft)!;

describe("stamping drafts as they change", () => {
  it("stamps a draft whose content changed, and one that went", () => {
    const before: Drafts = { a: written("hi"), b: written("bye") };
    const after: Drafts = { a: written("hi there") };
    const stamps = stampChanges(before, after, { a: stampOf(before.a, 1), b: stampOf(before.b, 1) }, 9);
    expect(stamps.a).toEqual(stampOf(after.a, 9));
    expect(stamps.b).toEqual({ at: 9, hash: "" });
  });

  it("leaves a draft alone when only what the page holds changed", () => {
    const draft = written("hi");
    const stamps = { a: stampOf(draft, 1) };
    expect(stampChanges({ a: draft }, { a: { ...draft } }, stamps, 9)).toBe(stamps);
  });

  it("forgets a gone draft's stamp after a month", () => {
    const month = 30 * 24 * 60 * 60 * 1000;
    expect(stampChanges({}, {}, { old: { at: 1, hash: "" } }, month + 2)).toEqual({});
  });
});

describe("reconciling drafts with the cloud's", () => {
  it("takes a newer edit from the cloud and sends a newer one of its own", () => {
    const local: Drafts = { a: written("mine"), b: written("mine too") };
    const stamps = { a: stampOf(local.a, 5), b: stampOf(local.b, 20) };
    const cloud: ReadonlyArray<DraftEntry> = [
      { key: "a", updatedAt: 10, draft: shared(written("theirs")) },
      { key: "b", updatedAt: 15, draft: shared(written("older")) },
    ];
    const { take, send } = reconcileDrafts(local, stamps, cloud, undefined);
    expect(take.map(({ key, draft }) => [key, draft?.segments])).toEqual([
      ["a", [{ kind: "text", text: "theirs" }]],
    ]);
    expect(send).toEqual([{ key: "b", updatedAt: 20, draft: shared(local.b) }]);
  });

  it("takes a draft sent elsewhere as gone, and tells the cloud of one gone here", () => {
    const local: Drafts = { a: written("still here") };
    const stamps = { a: stampOf(local.a, 5), b: { at: 30, hash: "" } };
    const cloud: ReadonlyArray<DraftEntry> = [
      { key: "a", updatedAt: 10 },
      { key: "b", updatedAt: 12, draft: shared(written("old")) },
    ];
    const { take, send } = reconcileDrafts(local, stamps, cloud, undefined);
    expect(take).toEqual([{ key: "a", draft: undefined, stamp: { at: 10, hash: "" } }]);
    expect(send).toEqual([{ key: "b", updatedAt: 30 }]);
    expect(applyTaken(local, take)).toEqual({});
  });

  it("sends nothing about a draft that went before it was ever shared", () => {
    expect(reconcileDrafts({}, { a: { at: 3, hash: "" } }, [], undefined).send).toEqual([]);
  });

  it("counts drafts written before syncing as older than any edit", () => {
    const local: Drafts = { a: written("from before"), b: written("only here") };
    const cloud: ReadonlyArray<DraftEntry> = [{ key: "a", updatedAt: 2, draft: shared(written("newer")) }];
    const { take, send } = reconcileDrafts(local, {}, cloud, undefined);
    expect(take.map(({ key }) => key)).toEqual(["a"]);
    expect(send).toEqual([{ key: "b", updatedAt: 1, draft: shared(local.b) }]);
  });

  it("names this computer in a new thread's draft it shares, and drops its name from one it takes", () => {
    const local: Drafts = { "new:1": written("here", { mode: "work", createdAt: 1, folder: "C:/app" }) };
    const { send } = reconcileDrafts(local, { "new:1": stampOf(local["new:1"], 4) }, [], "desk");
    expect(send[0]?.draft).toMatchObject({ start: { machine: "desk" } });

    const cloud: ReadonlyArray<DraftEntry> = [
      {
        key: "new:2",
        updatedAt: 9,
        draft: shared(written("from the phone", { mode: "chat", createdAt: 2, machine: "desk" })),
      },
    ];
    const { take } = reconcileDrafts({}, {}, cloud, "desk");
    expect(take[0]?.draft?.start).toEqual({ mode: "chat", createdAt: 2 });
  });

  it("leaves a draft it can't read alone", () => {
    const cloud: ReadonlyArray<DraftEntry> = [{ key: "a", updatedAt: 9, draft: { segments: 3 } }];
    expect(reconcileDrafts({}, {}, cloud, undefined)).toEqual({ take: [], send: [] });
  });
});

describe("batching drafts for the relay", () => {
  it("starts a new batch before one would grow too big", () => {
    const big = (key: string): DraftEntry => ({ key, updatedAt: 1, draft: "x".repeat(300_000) });
    expect(
      draftBatches([big("a"), big("b"), big("c")]).map((batch) => batch.map((entry) => entry.key)),
    ).toEqual([["a", "b"], ["c"]]);
  });
});
