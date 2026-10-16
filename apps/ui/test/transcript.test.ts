import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { transcriptFixture } from "../src/dev/transcriptFixture.ts";
import { buildTranscript } from "../src/features/transcript/model.ts";

const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map((payload, sequence) => ({
    id: `e${sequence}` as EventId,
    threadId: "t" as ThreadId,
    agentId: "a" as AgentId,
    sequence,
    at: sequence,
    payload,
  }));

describe("buildTranscript", () => {
  it("grows a streaming message from deltas until its completion replaces it", () => {
    const streaming = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "Hel" },
        { _tag: "MessageDelta", messageId: "m", text: "lo" },
      ),
    );
    expect(streaming).toEqual([{ kind: "message", id: "message:m", text: "Hello", streaming: true }]);

    const done = buildTranscript(
      events(
        { _tag: "MessageDelta", messageId: "m", text: "Hel" },
        { _tag: "MessageCompleted", messageId: "m", text: "Hello!" },
      ),
    );
    expect(done).toEqual([{ kind: "message", id: "message:m", text: "Hello!", streaming: false }]);
  });

  it("completes tool calls and attributes file changes to them", () => {
    const [tool] = buildTranscript(
      events(
        { _tag: "ToolCallStarted", callId: "c", toolName: "Edit", input: { file_path: "a.ts" } },
        { _tag: "ToolCallCompleted", callId: "c", output: "ok", isError: false },
        { _tag: "FileChanged", path: "a.ts", change: "modified" },
      ),
    );
    expect(tool).toMatchObject({ kind: "tool", status: "done", output: "ok", changedFiles: ["a.ts"] });
  });

  it("records how a permission request was resolved", () => {
    const [request] = buildTranscript(
      events(
        { _tag: "PermissionRequested", requestId: "c", toolName: "Bash", summary: "Run", input: {} },
        { _tag: "PermissionResolved", requestId: "c", decision: "deny", scope: "once" },
      ),
    );
    expect(request).toMatchObject({ kind: "permission", resolution: { decision: "deny", scope: "once" } });
  });

  it("turns delivered inputs into user messages and notices, and closes turns with their usage", () => {
    const blocks = buildTranscript(transcriptFixture);
    const kinds = blocks.map((block) => block.kind);
    expect(kinds[0]).toBe("user");
    expect(kinds.filter((kind) => kind === "notice")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "spawn")).toHaveLength(2);
    expect(blocks.find((block) => block.kind === "turnEnd")).toMatchObject({
      usage: { inputTokens: 60_322, outputTokens: 1_390, costUsd: 0.142 },
    });
    expect(blocks.at(-1)).toMatchObject({ kind: "permission", toolName: "Bash" });
    expect(blocks.at(-1)).not.toHaveProperty("resolution");
  });
});
