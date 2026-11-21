import type { AgentEvent, AgentId, EventId, EventPayload, FromUser, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { draftText, type Segment } from "../src/features/composer/draft.ts";
import { recalledPrompt, sentPrompts, stepPromptHistory } from "../src/features/composer/promptHistory.ts";

const entry = (text: string): ReadonlyArray<Segment> => [{ kind: "text", text }];
const step = (overrides: Partial<Parameters<typeof stepPromptHistory>[0]> = {}) =>
  stepPromptHistory({
    direction: "older",
    history: undefined,
    entries: [entry("first"), entry("latest\nprompt")],
    draft: [],
    atStart: true,
    empty: true,
    blocked: false,
    ...overrides,
  });

describe("composer prompt recall", () => {
  it("starts from the newest item and restores the original draft after traversing both ways", () => {
    const draft = entry("\n");
    const newest = step({ draft })?.history;
    expect(newest && recalledPrompt(newest)).toEqual(entry("latest\nprompt"));
    const oldest = step({ draft, history: newest, atStart: false, empty: false })?.history;
    expect(oldest && recalledPrompt(oldest)).toEqual(entry("first"));
    expect(step({ draft, history: oldest })?.history?.index).toBe(0);
    const forward = step({ draft, history: oldest, direction: "newer" })?.history;
    expect(forward && recalledPrompt(forward)).toEqual(entry("latest\nprompt"));
    expect(step({ draft, history: forward, direction: "newer" })).toEqual({ history: undefined });
    expect(forward?.draft).toBe(draft);
  });

  it("takes a stable snapshot when a new sent prompt arrives during recall", () => {
    const draft: ReadonlyArray<Segment> = [];
    const history = step({ draft })?.history;
    const next = step({ draft, history, entries: [entry("just queued")] })?.history;
    expect(next && recalledPrompt(next)).toEqual(entry("first"));
  });

  it("leaves normal caret movement alone after edits and inside multiline drafts", () => {
    const draft = entry("a\nb");
    const history = step()?.history;
    expect(step({ history, draft, empty: false })).toBeUndefined();
    expect(step({ history, draft, empty: false, direction: "newer" })).toBeUndefined();
    expect(step({ draft, atStart: false, empty: false })).toBeUndefined();
    expect(step({ atStart: false, draft: entry("\n\n") })).toBeUndefined();
    expect(step({ direction: "newer" })).toBeUndefined();
    expect(step({ entries: [] })).toBeUndefined();
  });

  it("leaves the arrows to an open menu, suggestion, or IME", () => {
    const draft = entry("\n");
    expect(step({ blocked: true, draft })).toBeUndefined();
    expect(
      step({ blocked: true, draft, history: step({ draft })?.history, direction: "newer" }),
    ).toBeUndefined();
  });
});

const event = (sequence: number, payload: EventPayload): AgentEvent => ({
  id: `event-${sequence}` as EventId,
  agentId: "lead" as AgentId,
  threadId: "thread" as ThreadId,
  at: sequence,
  sequence,
  payload,
});
const user = (id: string, text: string): FromUser => ({ _tag: "FromUser", id, text });

describe("sent prompts", () => {
  it("restores mentions and imported input, and keeps queued messages only once", () => {
    const words: FromUser = {
      ...user("message", "Review @docs/"),
      mentions: [{ _tag: "FileMention", path: "docs", folder: true }],
    };
    const history = sentPrompts([
      event(1, { _tag: "TurnInput", items: [{ _tag: "FromUser", text: "Imported" }] }),
      event(2, { _tag: "MessageQueued", message: words }),
      event(3, { _tag: "TurnInput", items: [words] }),
      event(4, { _tag: "MessageQueued", message: user("queued", "Still queued") }),
    ]);
    expect(history.map(draftText)).toEqual(["Imported", "Review @docs/", "Still queued"]);
    expect(history[1]?.[1]).toEqual({ kind: "mention", mention: words.mentions?.[0] });
  });

  it("drops withdrawn and replaced prompts, including queued messages at the rewind", () => {
    const history = sentPrompts([
      event(1, { _tag: "TurnInput", items: [user("kept", "Keep me")] }),
      event(2, { _tag: "TurnInput", items: [user("original", "Original")] }),
      event(3, { _tag: "MessageQueued", message: user("pre-rewind", "Never delivered") }),
      event(4, { _tag: "ConversationRewound", fromSequence: 2, messageId: "original", via: "fresh" }),
      event(5, { _tag: "MessageQueued", message: user("withdrawn", "Withdraw me") }),
      event(6, { _tag: "MessageWithdrawn", messageId: "withdrawn" }),
      event(7, { _tag: "TurnInput", items: [user("new", "Replacement")] }),
      event(8, { _tag: "MessageQueued", message: user("empty", " ") }),
    ]);
    expect(history.map(draftText)).toEqual(["Keep me", "Replacement"]);
  });

  it("keeps the most recent 50 messages", () => {
    const history = sentPrompts(
      Array.from({ length: 55 }, (_, number) =>
        event(number, { _tag: "TurnInput", items: [user(String(number), String(number))] }),
      ),
    );
    expect(history).toHaveLength(50);
    expect(history.at(0)).toEqual(entry("5"));
    expect(history.at(-1)).toEqual(entry("54"));
  });
});
