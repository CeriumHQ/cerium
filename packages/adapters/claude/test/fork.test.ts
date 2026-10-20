import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";

import { lastKept } from "../src/fork.ts";

const message = (uuid: string, type: SessionMessage["type"], content: unknown): SessionMessage => ({
  type,
  uuid,
  session_id: "s",
  message: { role: type, content },
  parent_tool_use_id: null,
  parent_agent_id: null,
});

const transcript: ReadonlyArray<SessionMessage> = [
  message("p1", "user", "one"),
  message("a1", "assistant", [{ type: "tool_use", id: "t1" }]),
  message("r1", "user", [{ type: "tool_result", tool_use_id: "t1" }]),
  message("a2", "assistant", [{ type: "text", text: "first" }]),
  message("p2", "user", [{ type: "text", text: "two" }]),
  message("i2", "user", [{ type: "text", text: "[Request interrupted by user]" }]),
  message("p3", "user", [{ type: "image" }, { type: "text", text: "three" }]),
  message("a3", "assistant", [{ type: "text", text: "third" }]),
];

describe("Claude fork points", () => {
  it("keeps what came before the turn Cerium's id names", () => {
    expect(lastKept(transcript, { id: "p3", index: 0 })).toBe("i2");
  });

  it("finds the turn by its place among the prompts when its id is gone", () => {
    // Tool results and the interruption marker aren't turns.
    expect(lastKept(transcript, { id: "remapped", index: 1 })).toBe("a2");
    expect(lastKept(transcript, { index: 2 })).toBe("i2");
  });

  it("finds nothing to keep before the first turn, or past the last", () => {
    expect(lastKept(transcript, { index: 0 })).toBeUndefined();
    expect(lastKept(transcript, { index: 3 })).toBeUndefined();
  });
});
