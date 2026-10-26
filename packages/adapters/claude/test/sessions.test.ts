import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";

import { promptText, toPastHistory } from "../src/sessions.ts";

const message = (uuid: string, type: SessionMessage["type"], body: unknown): SessionMessage => ({
  type,
  uuid,
  session_id: "s",
  message: body,
  parent_tool_use_id: null,
  parent_agent_id: null,
});

const user = (uuid: string, content: unknown) => message(uuid, "user", { role: "user", content });
const assistant = (uuid: string, content: unknown) =>
  message(uuid, "assistant", { id: `api-${uuid}`, model: "claude-opus-5-5", role: "assistant", content });

describe("Claude past sessions", () => {
  it("reads what the user typed, a slash command as typed, and skips what Claude Code wrote itself", () => {
    expect(promptText(user("1", "fix the build"))).toBe("fix the build");
    expect(
      promptText(user("2", "<command-name>/review</command-name><command-args> main </command-args>")),
    ).toBe("/review main");
    expect(promptText(user("3", "<local-command-stdout>done</local-command-stdout>"))).toBeUndefined();
    expect(promptText(user("4", [{ type: "image" }]))).toBe("(image)");
  });

  it("splits a transcript into turns translated like a live session", () => {
    const history = toPastHistory([
      user("p1", "list the files"),
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Glob", input: { pattern: "*" } }]),
      user("r1", [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }]),
      assistant("a2", [{ type: "text", text: "One file." }]),
      user("p2", [{ type: "text", text: "thanks" }]),
      assistant("a3", [{ type: "text", text: "Welcome." }]),
    ]);
    expect(history.model).toBe("claude-opus-5-5");
    expect(history.turns.map((turn) => turn.prompt)).toEqual(["list the files", "thanks"]);
    expect(history.turns[0]?.events.map((event) => event.payload._tag)).toEqual([
      "ToolCallStarted",
      "ToolCallCompleted",
      "MessageCompleted",
    ]);
    expect(history.turns[1]?.events.map((event) => event.payload)).toEqual([
      { _tag: "MessageCompleted", messageId: "api-a3:t0", text: "Welcome." },
    ]);
  });
});
