// Records the ACP traffic of one small real Grok Build session into test/fixtures, so the translation
// is tested against what `grok agent stdio` actually sends. Two turns in Cerium's "ask" access mode
// (`yoloMode: false`): a read, an edit, a command and a call to an injected MCP server, each approval
// allowed once; then a write whose approval is refused. The session is then listed and loaded as a
// past one, and compacted. It is deleted after.
// Paths are rewritten to `/work`, and Grok's notices about the user's own setup (their MCP servers,
// skills, models and settings) are left out.
//
// Needs a signed-in Grok Build (`grok login`). Usage:
//   node packages/adapters/grok/scripts/record-fixture.ts [model] (default: the user's own default)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const model = process.argv[2];
const home = process.env["GROK_HOME"] || join(homedir(), ".grok");
const executable = join(home, "bin", process.platform === "win32" ? "grok.exe" : "grok");
if (!existsSync(executable)) throw new Error(`Grok Build is not installed at ${executable}`);

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "cerium-fixture-")));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");
const echo = join(import.meta.dirname, "..", "..", "cursor", "scripts", "echo-mcp.ts");

/** Grok's notices that describe the user's own machine and setup rather than the session. */
const PRIVATE =
  /^_x\.ai\/(mcp\/servers_updated|mcp\/server_status|mcp\/init_progress|models\/update|settings\/update|announcements\/update|session\/setup|sessions\/changed|queue\/changed)$/;
/** The status of the session's own MCP server, which the adapter waits for, is the session's. */
const isOwnServer = (msg: Record<string, unknown>) =>
  msg["method"] === "_x.ai/mcp/server_status" &&
  (msg["params"] as { name?: unknown } | undefined)?.name === "smoke";

/** `text` as it appears in a line: JSON-escaped once, twice (JSON in a string), or URL-encoded. */
const spellings = (text: string) => {
  const once = JSON.stringify(text).slice(1, -1);
  return [JSON.stringify(once).slice(1, -1), once, encodeURIComponent(text)];
};
const sanitize = (line: string) => {
  let out = line;
  for (const [from, to] of [
    [workspace, "/work"],
    [workspace.replaceAll("\\", "/"), "/work"],
    [homedir(), "~"],
    [homedir().replaceAll("\\", "/"), "~"],
  ] as const) {
    for (const spelling of spellings(from)) out = out.replaceAll(spelling, to);
  }
  return out;
};

/** Updates the translation never reads: the user's commands and skills, and Grok's token stream. */
const UNREAD = new Set(["available_commands_update", "tool_call_delta_chunk"]);

const records: Array<string> = [];
const keep = (dir: "in" | "out", msg: Record<string, unknown>) => {
  if (dir === "in" && typeof msg["method"] === "string" && PRIVATE.test(msg["method"]) && !isOwnServer(msg)) {
    return;
  }
  const update = (msg["params"] as { update?: { sessionUpdate?: string } } | undefined)?.update;
  if (UNREAD.has(update?.sessionUpdate ?? "")) return;
  records.push(sanitize(JSON.stringify({ dir, msg })));
};

const child = spawn(executable, ["agent", "--no-leader", "stdio"], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, GROK_SUBAGENTS: "0" },
});
let nextId = 1;
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
let permission: "allow_once" | "reject_once" = "allow_once";
/** Settles once the smoke server has connected, as the adapter waits for before the first prompt. */
let smokeSettled = () => {};
const smokeReady = new Promise<void>((resolve) => {
  smokeSettled = resolve;
  setTimeout(resolve, 15_000).unref();
});

const send = (msg: Record<string, unknown>) => {
  keep("out", msg);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
};
const request = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line) as Record<string, unknown>;
  const id = msg["id"] as number | undefined;
  if (id !== undefined && msg["method"] === undefined && waiting.has(id)) {
    if (!(msg["result"] as Record<string, unknown> | undefined)?.["protocolVersion"]) keep("in", msg);
    waiting.get(id)!(msg);
    waiting.delete(id);
    return;
  }
  keep("in", msg);
  if (isOwnServer(msg) && (msg["params"] as { status?: unknown }).status !== "initializing") smokeSettled();
  if (msg["method"] === "session/request_permission") {
    const options = (msg["params"] as { options: Array<{ optionId: string; kind: string }> }).options;
    const option = options.find((each) => each.kind === permission) ?? options[0]!;
    send({ id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
  } else if (id !== undefined && msg["method"] !== undefined) {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
});

const initialized = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "cerium", title: "Cerium", version: "0.0.0" },
});
// Only what the adapter reads of it: the machine's name and the agent's ids stay out.
const agent = initialized["result"] as {
  protocolVersion: number;
  agentCapabilities: unknown;
  _meta?: { agentVersion?: string; modelState?: unknown };
};
writeFileSync(
  join(import.meta.dirname, "..", "test", "fixtures", "initialize.json"),
  `${JSON.stringify(
    {
      protocolVersion: agent.protocolVersion,
      agentCapabilities: agent.agentCapabilities,
      _meta: { agentVersion: agent._meta?.agentVersion, modelState: agent._meta?.modelState },
    },
    null,
    2,
  )}\n`,
);
const created = await request("session/new", {
  cwd: workspace,
  mcpServers: [{ name: "smoke", command: process.execPath, args: [echo], env: [] }],
  _meta: { yoloMode: false, autoMode: false, rules: "Keep every reply as short as the task allows." },
});
const sessionId = (created["result"] as { sessionId: string }).sessionId;
if (model !== undefined)
  await request("session/set_config_option", { sessionId, configId: "model", value: model });
await smokeReady;

const prompt = (text: string) => request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
await prompt(
  "Read hello.txt, then replace the word hello with goodbye in it, then run the command `git --version`, " +
    "then call the echo tool of the smoke MCP server with the text cerium. Finally reply DONE.",
);
permission = "reject_once";
await prompt("Create a file named new.txt containing the letter x.");
// The session as Cerium reads a past one: listed, then loaded, which replays its conversation.
await request("session/close", { sessionId });
await request("session/list", { cwd: workspace });
await request("session/load", { sessionId, cwd: workspace, mcpServers: [] });
await request("_x.ai/compact_conversation", { sessionId });
await request("_x.ai/session/delete", { sessionId });
child.stdin.end();
child.kill();

const out = join(import.meta.dirname, "..", "test", "fixtures", "session.jsonl");
writeFileSync(out, `${records.join("\n")}\n`);
console.log(`Recorded ${records.length} messages to ${out}`);
