import { describe, expect, it } from "@effect/vitest";

import type { ServerNotification } from "../src/protocol/ServerNotification.ts";
import { CodexTranslator } from "../src/translate.ts";

// SYNTHETIC: built from the generated `ItemStartedNotification` and `ItemCompletedNotification` types.
// A unified-exec command that keeps running after the model writes again goes on in the background.

const THREAD = "thr_1";

const command = (status: "inProgress" | "completed") =>
  ({
    type: "commandExecution",
    id: "call_1",
    command: "bun run dev",
    cwd: "/work",
    processId: "proc_7",
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: null,
  }) as never;

const started = (item: unknown): ServerNotification =>
  ({ method: "item/started", params: { threadId: THREAD, turnId: "turn_1", item } }) as never;

const completed = (item: unknown): ServerNotification =>
  ({ method: "item/completed", params: { threadId: THREAD, turnId: "turn_1", item } }) as never;

const translator = () => {
  const codex = new CodexTranslator();
  codex.started({ thread: { id: THREAD }, model: "gpt-6-luna", reasoningEffort: null } as never);
  return codex;
};

describe("CodexTranslator background commands", () => {
  it("marks a background command stoppable and knows the process that stops it", () => {
    const codex = translator();
    codex.translate(started(command("inProgress")));
    expect(codex.processOf("call_1")).toBeUndefined();
    const moved = codex
      .translate(started({ type: "agentMessage", id: "msg_1", text: "" }))
      .map((event) => event.payload);
    expect(moved).toContainEqual(
      expect.objectContaining({
        _tag: "BackgroundTasksChanged",
        tasks: [expect.objectContaining({ id: "call_1", kind: "command", stoppable: true })],
      }),
    );
    expect(codex.processOf("call_1")).toBe("proc_7");

    const ended = codex.translate(completed(command("completed"))).map((event) => event.payload);
    expect(ended).toContainEqual({ _tag: "BackgroundTasksChanged", tasks: [] });
    expect(codex.processOf("call_1")).toBeUndefined();
  });
});
