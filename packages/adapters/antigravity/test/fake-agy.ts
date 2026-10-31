// A scripted stand-in for `agy --input-format stream-json --output-format stream-json`, for the tests. It
// loads Cerium's agent the way Antigravity does (`--agent <name>` from $FAKE_GEMINI_HOME/config/agents,
// its `plugins:`, the plugin's `hooks.json`) and runs the PreToolUse hook command before each tool, so
// the whole approval path is exercised. The prompt's text picks what it does:
//   "hello"     a streamed reply and usage
//   "write"     write_file out.txt (needs approval)
//   "run"       run_command `ls` (needs approval)
//   "read"      read_file (a read: approved without asking)
//   "subagent"  invoke_subagent (always denied)
//   "slow"      a reply that runs until SIGINT, then a canceled result
//   "fail"      an ERROR result
// Every run's argv is appended to $FAKE_AGY_LOG.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
if (process.env["FAKE_AGY_LOG"]) appendFileSync(process.env["FAKE_AGY_LOG"], `${JSON.stringify(args)}\n`);

const conversation = flag("--conversation") ?? `conv-${process.pid}`;
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const step = (index: number, fields: Record<string, unknown>) =>
  out({ event: "step_update", step_update: { conversation_id: conversation, step_index: index, ...fields } });
const result = (fields: Record<string, unknown>) =>
  out({ event: "result", result: { conversation_id: conversation, num_turns: 1, ...fields } });

// Cerium's agent, as Antigravity would load it.
const agentName = flag("--agent")!;
const agent = readFileSync(
  join(process.env["FAKE_GEMINI_HOME"]!, "config", "agents", `${agentName}.md`),
  "utf8",
);
const pluginDirectory = /plugins:\n\s+- (.+)\n/.exec(agent)![1]!.trim();
const hooks = JSON.parse(readFileSync(join(pluginDirectory, "hooks.json"), "utf8")) as Record<
  string,
  { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
>;
const hookCommand = Object.values(hooks)[0]!.PreToolUse[0]!.hooks[0]!.command;

const preToolUse = (
  name: string,
  toolArgs: Record<string, unknown>,
): { decision: string; reason?: string } => {
  const answer = execFileSync("/bin/sh", ["-c", hookCommand], {
    input: JSON.stringify({ conversationId: conversation, toolCall: { name, args: toolArgs }, stepIdx: 1 }),
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return JSON.parse(answer.toString("utf8")) as { decision: string; reason?: string };
};

const tool = (index: number, name: string, parameters: Record<string, unknown>, run: () => string) => {
  const decision = preToolUse(name, parameters);
  step(index, { state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters } });
  if (decision.decision !== "auto_approve" && decision.decision !== "allow") {
    step(index, {
      state: "DONE",
      step_type: "tool",
      tool_name: name,
      tool_info: { name, parameters, error: { type: "denied", message: decision.reason ?? "denied" } },
    });
    return false;
  }
  step(index, {
    state: "DONE",
    step_type: "tool",
    tool_name: name,
    tool_info: { name, parameters, output: run() },
  });
  return true;
};

const usage = {
  input_tokens: 1200,
  output_tokens: 30,
  thinking_tokens: 10,
  cache_read_tokens: 200,
  total_tokens: 1240,
};

const turn = (text: string) => {
  out({
    event: "init",
    conversation_id: conversation,
    init: { cwd: process.cwd(), tools: ["read_file", "write_file"], permission_mode: "request-review" },
  });
  step(0, { state: "DONE", step_type: "user_input" });
  if (text.includes("fail")) {
    result({
      status: "ERROR",
      response: "",
      error: "API error: RESOURCE_EXHAUSTED (code 429): quota. Resets in 2m0s.",
      finished_reason: "error",
    });
    process.exit(3);
  }
  if (text.includes("slow")) {
    step(1, { state: "ACTIVE", step_type: "agent_response", text_delta: "Counting" });
    process.on("SIGINT", () => {
      result({ status: "CANCELED", response: "Counting", finished_reason: "interrupted" });
      process.exit(130);
    });
    setInterval(() => undefined, 1000);
    return;
  }
  let reply = "Hello there";
  if (text.includes("write")) {
    const wrote = tool(
      1,
      "write_file",
      { TargetFile: join(process.cwd(), "out.txt"), CodeContent: "ok" },
      () => {
        writeFileSync(join(process.cwd(), "out.txt"), "ok");
        return "Created out.txt";
      },
    );
    reply = wrote ? "Wrote it." : "Not allowed.";
  }
  if (text.includes("run"))
    reply = tool(1, "run_command", { CommandLine: "ls" }, () => "out.txt") ? "Ran it." : "Not allowed.";
  if (text.includes("read"))
    reply = tool(1, "read_file", { Path: "hello.txt" }, () => "hello") ? "Read it." : "Not allowed.";
  if (text.includes("subagent")) {
    reply = tool(1, "invoke_subagent", { Task: "x" }, () => "done") ? "Delegated." : "Not allowed.";
  }
  step(2, { state: "ACTIVE", step_type: "agent_response", text_delta: reply.slice(0, 3) });
  step(2, { state: "DONE", step_type: "agent_response", text_delta: reply.slice(3), usage });
  result({ status: "SUCCESS", response: reply, usage });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line) as { event: string; message: { content: string } };
  if (message.event === "user") turn(message.message.content);
});
