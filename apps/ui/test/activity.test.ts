import type { AgentEvent } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { liveActivity } from "../src/features/composer/activity.ts";
import type { TranscriptBlock } from "../src/features/transcript/model.ts";

const turn = { payload: { _tag: "TurnInput", items: [] }, at: 1_000 } as unknown as AgentEvent;

const tool = (status: "running" | "done", path: string): TranscriptBlock => ({
  kind: "tool",
  id: path,
  toolName: "Edit",
  input: { file_path: `src/${path}` },
  status,
  changedFiles: [],
});

describe("liveActivity", () => {
  it("is nothing before a turn begins", () => {
    expect(liveActivity([tool("running", "a.ts")], [])).toBeUndefined();
  });

  it("names the newest running tool call and the file it acts on", () => {
    expect(liveActivity([tool("done", "a.ts"), tool("running", "b.ts")], [turn])).toEqual({
      verb: "Edit",
      detail: "b.ts",
      since: 1_000,
    });
  });

  it("says thinking or writing between tool calls", () => {
    const thinking: TranscriptBlock = { kind: "reasoning", id: "r", text: "", streaming: true };
    const writing: TranscriptBlock = { kind: "message", id: "m", text: "", streaming: true };
    expect(liveActivity([tool("done", "a.ts"), thinking], [turn])?.verb).toBe("Thinking");
    expect(liveActivity([writing], [turn])?.verb).toBe("Writing");
    expect(liveActivity([tool("done", "a.ts")], [turn])?.verb).toBe("Working");
  });
});
