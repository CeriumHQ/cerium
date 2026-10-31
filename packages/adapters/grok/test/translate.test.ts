import { AcpTranslator, type AcpRecord } from "@cerium/adapter-acp";
import { EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describeGrokTool, grokTurnUsage } from "../src/harness.ts";

// `grok-session.jsonl` is hand-built, not recorded: no signed-in Grok Build was available. Its frames
// follow the shapes the Grok Build source sends (github.com/xai-org/grok-build, 2026-09-29): tool calls
// carry `_meta["x.ai/tool"]`, paths are relative to the session's folder, edit diffs hold the replaced
// fragment, and a prompt's answer carries the turn's usage in `_meta.usage`. `scripts/record-fixture.ts`
// records a real one to replace it.

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (name: string) =>
  readFileSync(join(fixtures, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as AcpRecord);
const records = fixture("grok-session.jsonl");

const translate = (input: ReadonlyArray<AcpRecord> = records) => {
  const translator = new AcpTranslator({
    provider: "grok",
    loginCommand: "grok login",
    cwd: "/work",
    mcpServers: ["cerium"],
    describeTool: (call, servers) => describeGrokTool(call, servers),
    turnUsage: (response) => grokTurnUsage(response),
  });
  return input.flatMap((record) => translator.translate(record)).map((event) => event.payload);
};

// Every fixture, recorded or hand-built, holds to the contract.
describe.each(readdirSync(fixtures).filter((name) => name.endsWith(".jsonl")))(
  "the contract on %s",
  (name) => {
    const input = fixture(name);
    const payloads = translate(input);

    it("emits only canonical payloads, starting the session once and first", () => {
      for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
      expect(payloads[0]?._tag).toBe("SessionStarted");
      expect(payloads.filter((payload) => payload._tag === "SessionStarted")).toHaveLength(1);
    });

    it("ends every prompt with exactly one TurnCompleted, after the turn's own events", () => {
      const prompts = input.filter((record) => record.type === "prompt").length;
      expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toHaveLength(prompts);
      expect(payloads.at(-1)?._tag).toBe("TurnCompleted");
    });

    it("pairs every tool call's start with one end", () => {
      const started = payloads.flatMap((payload) =>
        payload._tag === "ToolCallStarted" ? [payload.callId] : [],
      );
      const ended = payloads.flatMap((payload) =>
        payload._tag === "ToolCallCompleted" ? [payload.callId] : [],
      );
      expect(new Set(started).size).toBe(started.length);
      expect(ended.toSorted()).toEqual(started.toSorted());
    });
  },
);

describe("a Grok Build session through the ACP translator", () => {
  const payloads = translate();

  it("emits only canonical payloads", () => {
    for (const payload of payloads) expect(Schema.is(EventPayload)(payload)).toBe(true);
  });

  it("starts once and ends each prompt with one TurnCompleted", () => {
    expect(payloads.filter((payload) => payload._tag === "SessionStarted")).toHaveLength(1);
    expect(payloads.filter((payload) => payload._tag === "TurnCompleted")).toEqual([
      { _tag: "TurnCompleted", stopReason: "completed" },
      { _tag: "TurnCompleted", stopReason: "interrupted" },
    ]);
  });

  it("names Grok's tools as the transcript knows them, with absolute paths", () => {
    const started = payloads.flatMap((payload) => (payload._tag === "ToolCallStarted" ? [payload] : []));
    expect(started.map((call) => call.toolName)).toEqual([
      "read",
      "edit",
      "shell",
      "mcp__cerium__computer_read",
    ]);
    expect(started[0]!.input).toMatchObject({ path: "/work/hello.txt" });
    expect(started[1]!.input).toMatchObject({
      path: "/work/hello.txt",
      old_string: "hello",
      new_string: "hi",
    });
    expect(started[2]!.input).toMatchObject({ command: "ls -la", description: "List the folder" });
  });

  it("asks about the edit once, before it runs", () => {
    const asked = payloads.findIndex((payload) => payload._tag === "PermissionRequested");
    const edited = payloads.findIndex(
      (payload) => payload._tag === "ToolCallCompleted" && payload.callId === "call_edit",
    );
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(edited);
    expect(payloads[asked]).toMatchObject({ toolName: "edit", summary: "Edit hello.txt" });
  });

  it("reports outputs: a command with its exit code, a screenshot as MCP content", () => {
    const completed = new Map(
      payloads.flatMap((payload) =>
        payload._tag === "ToolCallCompleted" ? [[payload.callId, payload]] : [],
      ),
    );
    expect(completed.get("call_read")).toMatchObject({ output: "hello from cerium\n", isError: false });
    expect(completed.get("call_run")).toMatchObject({
      output: { output: "hello.txt\n", exitCode: 0 },
      isError: false,
    });
    expect(completed.get("call_shot")?.output).toEqual([
      { type: "text", text: "Finder, 1 window" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ]);
  });

  it("reports the edited file with its absolute path", () => {
    expect(payloads.filter((payload) => payload._tag === "FileChanged")).toEqual([
      { _tag: "FileChanged", path: "/work/hello.txt", change: "modified" },
    ]);
  });

  it("turns the plan into todos", () => {
    expect(payloads.find((payload) => payload._tag === "TodosUpdated")).toEqual({
      _tag: "TodosUpdated",
      items: [
        { text: "Read hello.txt", status: "completed" },
        { text: "Edit it", status: "inProgress" },
      ],
    });
  });

  it("joins message chunks into one message and keeps reasoning apart", () => {
    expect(
      payloads.filter((payload) => payload._tag === "MessageCompleted").map((payload) => payload.text),
    ).toEqual(["Done: edited hello.txt.", "Working on"]);
    expect(payloads.find((payload) => payload._tag === "ReasoningCompleted")).toMatchObject({
      text: "Reading the file first.",
    });
  });

  it("counts the whole prompt's usage, without cache reads in the input, and trusts only a complete cost", () => {
    const usage = payloads.filter((payload) => payload._tag === "UsageReported");
    expect(usage).toEqual([
      // 9000 in, 6000 of them cached; reasoning (120) counted apart in the total (9000+300+120).
      {
        _tag: "UsageReported",
        inputTokens: 3000,
        outputTokens: 420,
        cachedInputTokens: 6000,
        costUsd: 0.0021,
      },
      // An incomplete bill keeps its tokens and drops its cost.
      { _tag: "UsageReported", inputTokens: 100, outputTokens: 5, cachedInputTokens: 900 },
    ]);
  });
});
