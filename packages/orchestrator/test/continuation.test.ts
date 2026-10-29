import type { AgentEvent, EventPayload } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";

import { continuationBrief, continuationParts } from "../src/continuation.ts";

/** A conversation of one agent, numbered as the store would. */
const log = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map(
    (payload, sequence) =>
      ({
        id: `a:${sequence}`,
        threadId: "t",
        agentId: "a",
        sequence,
        at: sequence,
        payload,
      }) as AgentEvent,
  );

const queued = (id: string, text: string): EventPayload => ({
  _tag: "MessageQueued",
  message: { _tag: "FromUser", id, text },
});
const turn = (id: string, text: string): EventPayload => ({
  _tag: "TurnInput",
  items: [{ _tag: "FromUser", id, text }],
});
const reply = (text: string): EventPayload => ({ _tag: "MessageCompleted", messageId: text, text });

describe("continuation briefs", () => {
  it("quotes the first and last requests, the last reply, the plan and the branch", () => {
    const events = log(
      queued("m1", "  Add a cache to the parser  "),
      turn("m1", "  Add a cache to the parser  "),
      reply("Started on the cache."),
      queued("m2", "Now the tests"),
      turn("m2", "Now the tests"),
      { _tag: "TodosUpdated", items: [{ text: "Write the tests", status: "inProgress" }] },
      reply("The tests pass."),
    );
    const brief = continuationBrief(events, {
      title: "Parser cache",
      branch: "cerium/parser-cache",
      base: "main",
      commits: "abc123 feat: cache parses\n",
      status: " M src/parse.ts",
      pullRequest: { number: 7, title: "Cache parses", url: "https://x/7", state: "open", draft: false },
    });
    assert.include(brief, "This thread continues “Parser cache”");
    assert.include(brief, "## Original request\n\nAdd a cache to the parser");
    assert.include(brief, "## Last message from the user\n\nNow the tests");
    assert.include(brief, "## Last reply\n\nThe tests pass.");
    assert.notInclude(brief, "Started on the cache.");
    assert.include(brief, "- [~] Write the tests");
    assert.include(brief, "Branch `cerium/parser-cache` (from `main`).");
    assert.include(brief, "abc123 feat: cache parses");
    assert.include(brief, " M src/parse.ts");
    assert.include(brief, "Pull request #7 “Cache parses” (open): https://x/7");
  });

  it("names one request once, and leaves out what a rewind replaced", () => {
    const events = log(
      queued("m1", "First"),
      turn("m1", "First"),
      reply("One"),
      turn("m2", "Wrong turn"),
      reply("Two"),
      { _tag: "ConversationRewound", fromSequence: 3, messageId: "m2", via: "fork" },
    );
    const parts = continuationParts(events);
    assert.strictEqual(parts.first, "First");
    assert.isUndefined(parts.last);
    assert.strictEqual(parts.reply, "One");
  });

  it("starts a thread continued twice from the first thread's request, and leaves out git it hasn't", () => {
    const earlier = continuationBrief(log(turn("m1", "The real request"), reply("Done.")), { title: "A" });
    const brief = continuationBrief(log(turn("m1", earlier), reply("More done.")), { title: "A" });
    assert.include(brief, "## Original request\n\nThe real request\n\n## Last reply\n\nMore done.");
    assert.notInclude(brief, "Where the work stands");
  });

  it("cuts long messages and git's output to size", () => {
    const brief = continuationBrief(log(turn("m1", "x".repeat(20_000))), {
      title: "Big",
      branch: "b",
      commits: Array.from({ length: 100 }, (_, index) => `c${index} commit`).join("\n"),
    });
    assert.isBelow(brief.length, 8_000);
    assert.include(brief, "… 60 more");
    assert.include(brief, "Nothing uncommitted.");
  });
});
