import { describe, expect, it } from "@effect/vitest";

import { foldOf } from "../src/features/transcript/FoldedText.tsx";
import { layout, showsProgress, type Item } from "../src/features/transcript/layout.ts";
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
const reasoning = (id: string): TranscriptBlock => ({ kind: "reasoning", id, text: "hmm", streaming: false });

/** The items with each response's work opened up into its steps. */
const opened = (items: ReadonlyArray<Item>): ReadonlyArray<Item> =>
  items.flatMap((item) => (item.kind === "work" ? item.steps : [item]));

describe("layout", () => {
  it("groups long consecutive stretches without changing their order, ids or earlier layouts", () => {
    const calls = Array.from({ length: 10_000 }, (_, index) => tool(String(index), "Read"));
    const first = opened(layout(calls));
    const next = opened(layout([...calls, tool("last", "Read")]));
    const run = first[0];
    expect(run?.kind).toBe("run");
    if (run?.kind !== "run") return;
    const group = run.steps[0];
    expect(run.id).toBe("run:tool:0");
    expect(group?.kind).toBe("tools");
    if (group?.kind !== "tools") return;
    expect(group.id).toBe("tool:0");
    expect(group.tools).toEqual(calls);
    expect(next).not.toEqual(first);
    expect(group.tools).toHaveLength(10_000);
    expect(layout([user("one"), user("two")])).toEqual([
      { kind: "input", id: "one", blocks: [user("one"), user("two")] },
    ]);
  });

  it("gathers a response's work ahead of its final message, and puts that message on its end", () => {
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
      "work",
      "block",
      "turnEnd",
      "input",
      "block",
      "turnEnd",
    ]);
    const work = items[1];
    expect(work?.kind === "work" && work.done).toBe(true);
    expect(work?.kind === "work" && work.steps.map((step) => step.id)).toEqual(["m1", "run:tool:t1"]);
    expect(
      items.filter((item) => item.kind === "turnEnd").map((item) => "text" in item && item.text),
    ).toEqual(["Second.", "Third."]);
  });

  it("counts a message as final until a call follows it, and the work as live until then", () => {
    const writing = layout([user("u"), tool("t1", "Read"), message("m1", "Look", true)]);
    expect(writing.map((item) => item.kind)).toEqual(["input", "work", "block"]);
    expect(writing[1]?.kind === "work" && writing[1].done).toBe(true);

    const onward = layout([user("u"), tool("t1", "Read"), message("m1", "Look"), tool("t2", "Grep")]);
    expect(onward.map((item) => item.kind)).toEqual(["input", "work"]);
    expect(onward[1]?.kind === "work" && onward[1].done).toBe(false);
    expect(showsProgress(onward[1])).toBe(true);
  });

  it("keeps what the user should see out of the work: agents started, failures, waiting approvals", () => {
    const items = layout([
      user("u"),
      tool("t1", "Read"),
      {
        kind: "spawn",
        id: "spawn:a",
        childId: "a",
        role: "scout",
        provider: "claude",
        model: "m",
        access: "readOnly",
      },
      tool("t2", "Read"),
      { kind: "error", id: "err", message: "The model is overloaded." },
    ]);
    expect(items.map((item) => item.kind)).toEqual(["input", "work", "spawns", "block"]);
    // The turn ended with nothing more to say: its work is over, and its end copies nothing.
    const ended = layout([user("u"), tool("t1", "Read"), turnEnd("e")]);
    expect(ended.map((item) => item.kind)).toEqual(["input", "work", "turnEnd"]);
    expect(ended[1]?.kind === "work" && ended[1].done).toBe(true);
    expect(ended[2]?.kind === "turnEnd" && ended[2].text).toBe("");
  });

  it("folds a stretch of tool calls and the reasoning between them into one run", () => {
    const items = layout([user("u1"), tool("t1", "Read"), reasoning("r1"), tool("t2", "Grep")]);
    expect(opened(items).map((item) => item.kind)).toEqual(["input", "run"]);
  });

  it("leaves a spawn call to its agent's card, unless the call made none", () => {
    const spawned = tool("s1", "mcp__cerium__spawn_agent", { status: "spawned", agentId: "a" });
    expect(layout([user("u"), spawned]).map((item) => item.kind)).toEqual(["input"]);

    const refused = tool("s2", "mcp__cerium__spawn_agent", "Only a lead can spawn agents.", "error");
    expect(opened(layout([user("u"), refused])).map((item) => item.kind)).toEqual(["input", "run"]);

    const asked = tool("s3", "mcp__cerium__spawn_agent", [
      { type: "text", text: JSON.stringify({ status: "pendingApproval", requestId: "r" }) },
    ]);
    expect(layout([user("u"), asked]).map((item) => item.kind)).toEqual(["input", "spawnAsk"]);
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
    expect(pending.map((item) => item.kind)).toEqual(["input", "block"]);
    const decided = layout([
      user("u"),
      tool("c", "Bash", "ok"),
      permission({ decision: "allow", scope: "once" }),
    ]);
    expect(opened(decided).map((item) => item.kind)).toEqual(["input", "run"]);
    // A decided request whose call left no row still tells what was decided.
    const alone = layout([
      user("u"),
      tool("other", "Bash", "ok"),
      permission({ decision: "deny", scope: "once" }),
    ]);
    expect(opened(alone).map((item) => item.kind)).toEqual(["input", "run", "block"]);
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
    expect(items.map((item) => item.kind)).toEqual(["input", "block", "turnEnd", "block"]);

    const refused = tool("c2", "mcp__cerium__ask_user", "Ask at most four questions.", "error");
    expect(opened(layout([user("u"), refused])).map((item) => item.kind)).toEqual(["input", "run"]);
  });
});

describe("showsProgress", () => {
  it("is true while a tool runs or text streams, and false once the agent has gone quiet", () => {
    const [, running] = layout([user("u"), tool("t", "Bash", undefined, "running")]);
    expect(showsProgress(running)).toBe(true);
    const [, streaming] = layout([user("u"), message("m", "Hel", true)]);
    expect(showsProgress(streaming)).toBe(true);
    const [, done] = layout([user("u"), message("m", "Hello")]);
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
    const [, open] = layout([user("u"), question]);
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
