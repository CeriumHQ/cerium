import { describe, expect, it } from "@effect/vitest";

import { withComments, type Draft } from "../src/features/composer/draft.ts";
import {
  mergeDrafts,
  newThreadDrafts,
  parseDrafts,
  serializeDrafts,
  withDraft,
  withoutDraft,
  type Drafts,
} from "../src/features/composer/drafts.ts";

const text = (value: string): Draft["segments"][number] => ({ kind: "text", text: value });

const screenshot = {
  path: "C:/data/attachments/0190/shot.png",
  name: "shot.png",
  mediaType: "image/png",
};

const work: Draft = {
  segments: [
    text("Fix the login flow\nIt loops on Windows"),
    { kind: "mention", mention: { _tag: "FileMention", path: "src/auth.ts", folder: false } },
  ],
  attachments: [
    {
      id: "a",
      name: "shot.png",
      mediaType: "image/png",
      preview: "blob:1",
      state: { _tag: "Ready", attachment: screenshot },
    },
    { id: "b", name: "big.mov", mediaType: "video/quicktime", state: { _tag: "Preparing" } },
  ],
  start: { mode: "work", createdAt: 2, folder: "C:/code/app", access: "readOnly" },
};

describe("serializeDrafts and parseDrafts", () => {
  it("keeps text, chips, ready files and how a new thread starts, but not what only the page has", () => {
    const restored = parseDrafts(serializeDrafts({ "new:1": work }));
    const draft = restored["new:1"]!;
    expect(draft.segments).toEqual(work.segments);
    expect(draft.start).toEqual(work.start);
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]).toMatchObject({
      name: "shot.png",
      state: { _tag: "Ready", attachment: screenshot },
    });
    expect(draft.attachments[0]?.preview).toBeUndefined();
  });

  it("keeps a draft that holds only comments on the agent's response", () => {
    const comments = [{ id: "c", quote: "Use a mutex", text: "Why not a channel?" }];
    const restored = parseDrafts(serializeDrafts({ thread: { segments: [], attachments: [], comments } }));
    expect(restored["thread"]?.comments).toEqual(comments);
  });

  it("leaves out drafts with nothing to send", () => {
    const blank: Draft = { segments: [text("  ")], attachments: [], start: { mode: "chat", createdAt: 1 } };
    expect(JSON.parse(serializeDrafts({ "new:1": blank }))).toEqual({});
  });

  it("drops a draft that no longer reads without losing the others", () => {
    const stored = JSON.stringify({
      thread: { segments: [text("hello")], attachments: [] },
      broken: { segments: "nope" },
    });
    expect(Object.keys(parseDrafts(stored))).toEqual(["thread"]);
    expect(parseDrafts("not json")).toEqual({});
    expect(parseDrafts(undefined)).toEqual({});
  });
});

describe("withDraft", () => {
  it("drops a thread's draft once it is emptied, but keeps a new thread's picks", () => {
    const drafts: Drafts = { thread: { segments: [text("hi")], attachments: [] } };
    expect(withDraft(drafts, "thread", (draft) => ({ ...draft, segments: [] }))).toEqual({});
    const picked = withDraft({}, "new:1", () => ({
      segments: [],
      attachments: [],
      start: { mode: "work", createdAt: 1, model: "m" },
    }));
    expect(picked["new:1"]?.start?.model).toBe("m");
    expect(withoutDraft(picked, "new:1")).toEqual({});
  });
});

describe("newThreadDrafts", () => {
  it("lists new threads with something in them, newest first, titled by their first line", () => {
    const drafts: Drafts = {
      "new:old": { segments: [text("Older idea")], attachments: [], start: { mode: "chat", createdAt: 1 } },
      "new:work": work,
      "new:empty": { segments: [], attachments: [], start: { mode: "work", createdAt: 3 } },
      thread: { segments: [text("a reply")], attachments: [] },
    };
    expect(newThreadDrafts(drafts).map((draft) => [draft.key, draft.title, draft.attachments])).toEqual([
      ["new:work", "Fix the login flow", 2],
      ["new:old", "Older idea", 0],
    ]);
  });

  it("names a draft with only files after its first one", () => {
    const files: Draft = { ...work, segments: [] };
    expect(newThreadDrafts({ "new:1": files })[0]).toMatchObject({ title: "shot.png", untitled: true });
  });
});

describe("mergeDrafts", () => {
  it("keeps this window's copy of a draft another tab didn't change", () => {
    const incoming = parseDrafts(
      serializeDrafts({ "new:1": work, "new:2": { ...work, segments: [text("other tab")] } }),
    );
    const merged = mergeDrafts({ "new:1": work }, incoming);
    expect(merged["new:1"]).toBe(work);
    expect(merged["new:2"]?.segments).toEqual([text("other tab")]);
  });
});

describe("withComments", () => {
  it("quotes each passage above its comment, then the message's own text", () => {
    const comments = [
      { id: "a", quote: "  Use a mutex\n\n\n\nfor the cache  ", text: " Why not a channel? " },
      { id: "b", quote: "Retry three times", text: "" },
    ];
    expect(withComments("  Otherwise looks good.\n", comments)).toBe(
      "> Use a mutex\n>\n> for the cache\n\nWhy not a channel?\n\n> Retry three times\n\nOtherwise looks good.",
    );
  });

  it("is the text alone without comments", () => {
    expect(withComments(" Ship it ", [])).toBe("Ship it");
  });
});
