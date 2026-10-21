import { describe, expect, it } from "@effect/vitest";

import { foldOf } from "../src/features/transcript/FoldedText.tsx";
import { layout, showsProgress } from "../src/features/transcript/layout.ts";
import type { TranscriptBlock } from "../src/features/transcript/model.ts";

const user = (id: string, text = "Hi"): TranscriptBlock => ({
  kind: "user",
  id,
  text,
  attachments: [],
  mentions: [],
});
const message = (id: string, text: string, streaming = false): TranscriptBlock => ({
  kind: "message",
  id,
  text,
  streaming,
});
const tool = (
  id: string,
  toolName: string,
  output?: unknown,
  status: "running" | "done" | "error" = "done",
): TranscriptBlock => ({
  kind: "tool",
  id: `tool:${id}`,
  toolName,
  input: {},
  output,
  status,
  changedFiles: [],
});
const turnEnd = (id: string, stopReason = "completed"): TranscriptBlock => ({
  kind: "turnEnd",
  id: `turnEnd:${id}`,
  stopReason,
});

describe("layout", () => {
  it("gives each response one header and puts the text it said on its end", () => {
    const items = layout([
      user("u1"),
      message("m1", "First."),
      tool("t1", "Read"),
      message("m2", "Second."),
      turnEnd("e1"),
      user("u2"),
      message("m3", "Third."),
      turnEnd("e2"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "input",
      "header",
      "block",
      "run",
      "block",
      "turnEnd",
      "input",
      "header",
      "block",
      "turnEnd",
    ]);
    expect(
      items.filter((item) => item.kind === "turnEnd").map((item) => "text" in item && item.text),
    ).toEqual(["First.\n\nSecond.", "Third."]);
  });

  it("folds a stretch of tool calls and the reasoning between them into one run", () => {
    const items = layout([
      user("u1"),
      tool("t1", "Read"),
      { kind: "reasoning", id: "r1", text: "hmm", streaming: false },
      tool("t2", "Grep"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["input", "header", "run"]);
  });

  it("leaves a spawn call to its agent's card, unless the call made none", () => {
    const spawned = tool("s1", "mcp__cerium__spawn_agent", { status: "spawned", agentId: "a" });
    expect(layout([user("u"), spawned]).map((item) => item.kind)).toEqual(["input"]);

    const refused = tool("s2", "mcp__cerium__spawn_agent", "Only a lead can spawn agents.", "error");
    expect(layout([user("u"), refused]).map((item) => item.kind)).toEqual(["input", "header", "run"]);

    const asked = tool("s3", "mcp__cerium__spawn_agent", [
      { type: "text", text: JSON.stringify({ status: "pendingApproval", requestId: "r" }) },
    ]);
    expect(layout([user("u"), asked]).map((item) => item.kind)).toEqual(["input", "header", "spawnAsk"]);
  });

  it("shows a pending approval's card in place of the call it gates, and the call once decided", () => {
    const permission = (resolution?: { decision: "allow" | "deny"; scope: "once" | "session" }) =>
      ({
        kind: "permission",
        id: "permission:c",
        toolName: "Bash",
        summary: "Run",
        input: {},
        ...(resolution ? { resolution } : {}),
      }) satisfies TranscriptBlock;
    const pending = layout([user("u"), tool("c", "Bash", undefined, "running"), permission()]);
    expect(pending.map((item) => item.kind)).toEqual(["input", "header", "block"]);
    const decided = layout([
      user("u"),
      tool("c", "Bash", "ok"),
      permission({ decision: "allow", scope: "once" }),
    ]);
    expect(decided.map((item) => item.kind)).toEqual(["input", "header", "run"]);
  });

  it("shows a question as its card, and what the agent does with the answer as a new response", () => {
    const question = {
      kind: "question",
      id: "question:q",
      requestId: "q",
      questions: [{ question: "Which?", options: [], multiSelect: false, allowOther: true }],
      at: 0,
      resolution: { outcome: "answered", answers: [{ choices: [], text: "That one" }] },
    } satisfies TranscriptBlock;
    const answer = {
      kind: "notice",
      id: "n",
      item: { _tag: "SystemNotice", text: "The user answered…", questionId: "q" },
    } satisfies TranscriptBlock;
    const items = layout([
      user("u"),
      tool("c", "mcp__cerium__ask_user", { status: "asked" }),
      question,
      turnEnd("e1"),
      answer,
      message("m", "Going with that one."),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "input",
      "header",
      "block",
      "turnEnd",
      "header",
      "block",
    ]);

    const refused = tool("c2", "mcp__cerium__ask_user", "Ask at most four questions.", "error");
    expect(layout([user("u"), refused]).map((item) => item.kind)).toEqual(["input", "header", "run"]);
  });
});

describe("showsProgress", () => {
  it("is true while a tool runs or text streams, and false once the agent has gone quiet", () => {
    const [, , running] = layout([user("u"), tool("t", "Bash", undefined, "running")]);
    expect(showsProgress(running)).toBe(true);
    const [, , streaming] = layout([user("u"), message("m", "Hel", true)]);
    expect(showsProgress(streaming)).toBe(true);
    const [, , done] = layout([user("u"), message("m", "Hello")]);
    expect(showsProgress(done)).toBe(false);
  });

  it("is true while a question waits on the user", () => {
    const question = {
      kind: "question",
      id: "question:q",
      requestId: "q",
      questions: [{ question: "Which?", options: [], multiSelect: false, allowOther: true }],
      at: 0,
    } satisfies TranscriptBlock;
    const [, , open] = layout([user("u"), question]);
    expect(showsProgress(open)).toBe(true);
  });
});

describe("foldOf", () => {
  it("folds a message of many lines, or of very many characters, and counts its lines", () => {
    expect(foldOf("one\ntwo")).toEqual({ lines: 2, folds: false });
    expect(foldOf(Array.from({ length: 15 }, (_, index) => `line ${index}`).join("\n"))).toEqual({
      lines: 15,
      folds: true,
    });
    expect(foldOf("a".repeat(1600)).folds).toBe(true);
    expect(foldOf("short\n\n\n").lines).toBe(1);
  });
});
