import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, AgentId, EventId, ThreadId } from "@cerium/protocol";

import { messagesFromHistory, modelMatches, searchableText } from "../src/features/transcript/searchModel.ts";

describe("transcript model search", () => {
  it("finds phrases across Markdown formatting, excluding artifact source and link addresses", () => {
    expect(
      searchableText(
        "A **bold** phrase and [docs](https://hidden.example).\n\n```artifact\n<h1>Hidden source</h1>\n```",
      ),
    ).toContain("A bold phrase and docs.");
    const messages = [{ id: "old-unmounted", text: "A **bold** phrase. A bold phrase." }];
    expect(modelMatches(messages, "bold phrase").map((match) => [match.message.id, match.ordinal])).toEqual([
      ["old-unmounted", 0],
      ["old-unmounted", 1],
    ]);
    expect(modelMatches([{ id: "a", text: "[docs](https://hidden.example)" }], "hidden")).toEqual([]);
  });
  it("keeps replaced versions searchable and carries a durable navigation target for each message", () => {
    const event = (sequence: number, payload: AgentEvent["payload"]): AgentEvent => ({
      id: `e${sequence}` as EventId,
      sequence,
      at: sequence,
      agentId: "a" as AgentId,
      threadId: "t" as ThreadId,
      payload,
    });
    const history = [
      event(0, { _tag: "TurnInput", items: [{ _tag: "FromUser", id: "old", text: "original request" }] }),
      event(1, { _tag: "MessageCompleted", messageId: "reply", text: "original answer" }),
      event(2, { _tag: "ConversationRewound", messageId: "old", fromSequence: 0, via: "fresh" }),
      event(3, { _tag: "TurnInput", items: [{ _tag: "FromUser", id: "new", text: "replacement" }] }),
    ];
    const messages = messagesFromHistory(history);
    expect(messages.map((message) => message.id)).toEqual(["old", "message:reply", "new"]);
    expect(modelMatches(messages, "original")).toHaveLength(2);
    expect(messages[0]?.cursor).toEqual({ id: "e0", at: 0, sequence: 0 });
  });
});
