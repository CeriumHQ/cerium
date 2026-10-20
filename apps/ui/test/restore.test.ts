import { describe, expect, it } from "@effect/vitest";

import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";

import { layout } from "../src/features/transcript/layout.ts";
import { buildTranscript } from "../src/features/transcript/model.ts";
import {
  agentsLine,
  conversationLine,
  filesLine,
  messagesLine,
  previewFailure,
} from "../src/features/transcript/restore.ts";

const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map((payload, sequence) => ({
    id: `e${sequence}` as EventId,
    threadId: "t" as ThreadId,
    agentId: "a" as AgentId,
    sequence,
    at: sequence,
    payload,
  }));

describe("a restored thread", () => {
  it("says on the earlier version how many files went back", () => {
    const items = layout(
      buildTranscript(
        events(
          { _tag: "MessageQueued", message: { _tag: "FromUser", id: "m1", text: "one" } },
          { _tag: "TurnInput", items: [{ _tag: "FromUser", id: "m1", text: "one" }] },
          { _tag: "MessageCompleted", messageId: "r1", text: "done" },
          { _tag: "TurnCompleted", stopReason: "completed" },
          { _tag: "ConversationRewound", fromSequence: 0, messageId: "m1", via: "fork" },
          { _tag: "FilesRestored", messageId: "m1", paths: ["a.ts", "b.ts"] },
        ),
      ),
    );
    expect(items).toMatchObject([{ kind: "replaced", turns: 1, files: 2 }]);
  });
});

describe("restore wording", () => {
  it("counts the messages that go, this one included", () => {
    expect(messagesLine(1)).toBe("Removes this message and what came after it");
    expect(messagesLine(2)).toBe("Removes this message and the one you sent after it");
    expect(messagesLine(4)).toBe("Removes this message and the 3 you sent after it");
  });

  it("says how the conversation goes back by the harness's name", () => {
    expect(conversationLine("fork", "Claude")).toBe("Claude picks up from just before it");
    expect(conversationLine("fresh", "Codex")).toBe("Codex starts a new session");
    expect(conversationLine("replay", "Cursor")).toContain("Cursor can't go back");
  });

  it("names the agents that stop", () => {
    expect(
      agentsLine([
        { id: "a" as AgentId, role: "reviewer", model: "sonnet" },
        { id: "b" as AgentId, role: "tester", model: "haiku" },
      ]),
    ).toBe("Stops 2 agents: reviewer, tester");
  });

  it("says what becomes of the files", () => {
    expect(filesLine({ unavailable: "No snapshot." })).toBe("No snapshot.");
    expect(filesLine({ restored: [], kept: [] })).toBe("No files changed since, so none change now");
    expect(filesLine({ restored: [], kept: [{ path: "a.ts", thread: "Other" }] })).toBe(
      "Files stay as they are",
    );
    expect(filesLine({ restored: [{ path: "a.ts", undo: "edit" }], kept: [] })).toBe(
      "Puts back 1 file the thread's agents changed since",
    );
  });

  it("says why the preview couldn't be read", () => {
    expect(previewFailure({ message: "The thread is gone." })).toBe("The thread is gone.");
    expect(previewFailure(undefined)).toBe("Couldn't check what a restore would undo.");
  });
});
