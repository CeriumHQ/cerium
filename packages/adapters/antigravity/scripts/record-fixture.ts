// Records a native signed-in ACP turn, excluding auth requests, account details and other sessions.
// Writes a new sanitized scratch recording, never a test fixture automatically. Needs native sign-in.
// Usage: node packages/adapters/antigravity/scripts/record-fixture.ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Option } from "effect";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentCommand, findAntigravity } from "../src/probe.ts";

const executable = await Effect.runPromise(findAntigravity.pipe(Effect.provide(NodeServices.layer)));
if (Option.isNone(executable)) throw new Error("Install the official Antigravity ACP runtime first.");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cerium-agy-fixture-")));
writeFileSync(join(cwd, "hello.txt"), "PELICAN-42\n");
const command = agentCommand(executable.value);
const child = spawn(command.executable, [...command.args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
const lines: string[] = [];
let stderr = "",
  next = 1,
  sessionId: string | undefined;
let answer: "allow_once" | "reject_once" = "allow_once";
const waiting = new Map<
  number,
  { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
>();
const sanitize = (value: unknown) => {
  let line = JSON.stringify(value);
  for (const [from, to] of [
    [cwd, "/work"],
    [homedir(), "~"],
  ]) {
    for (const path of [from!, from!.replaceAll("\\", "/")]) {
      const escaped = JSON.stringify(path).slice(1, -1);
      line = line.replaceAll(JSON.stringify(escaped).slice(1, -1), to!).replaceAll(escaped, to!);
    }
  }
  return line;
};
const send = (message: Record<string, unknown>) => {
  lines.push(sanitize({ dir: "out", msg: message }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
};
const request = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    send({ id, method, params });
  });
const stop = (error: Error) => {
  for (const pending of waiting.values()) pending.reject(error);
  waiting.clear();
};
child.on("error", stop);
child.on("exit", (code) => stop(new Error(`Runtime exited (${code}): ${stderr.slice(-1500)}`)));
child.stderr.on("data", (chunk) => {
  stderr = (stderr + String(chunk)).slice(-4000);
});
createInterface({ input: child.stdout }).on("line", (line) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  } // Native sign-in notices are never saved.
  const params = message["params"] as
    | {
        sessionId?: string;
        options?: { optionId: string; kind: string }[];
        toolCall?: { toolCallId?: string };
      }
    | undefined;
  if (message["method"] === "session/request_permission") {
    if (params === undefined || params.sessionId !== sessionId) return;
    lines.push(sanitize({ dir: "in", msg: message }));
    const option = params.toolCall?.toolCallId?.startsWith("interaction_")
      ? undefined
      : params.options?.find((option) => option.kind === answer);
    send({
      id: message["id"],
      result: {
        outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" },
      },
    });
    return;
  }
  if (message["method"]) {
    if (params?.sessionId === sessionId) lines.push(sanitize({ dir: "in", msg: message }));
    return;
  }
  const id = message["id"];
  if (typeof id !== "number") return;
  const pending = waiting.get(id);
  if (!pending) return;
  waiting.delete(id);
  if (message["error"]) {
    pending.reject(new Error(JSON.stringify(message["error"])));
    return;
  }
  lines.push(sanitize({ dir: "in", msg: message }));
  pending.resolve((message["result"] ?? {}) as Record<string, unknown>);
});
const deadline = setTimeout(() => {
  stop(new Error("Recording exceeded three minutes"));
  child.kill();
}, 180_000);
try {
  await request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "cerium", version: "0.0.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const setup = await request("session/new", {
    cwd,
    mcpServers: [
      {
        name: "smoke",
        command: process.execPath,
        args: [join(import.meta.dirname, "../../cursor/scripts/echo-mcp.ts")],
        env: [],
      },
    ],
  });
  sessionId = setup["sessionId"] as string;
  if (!sessionId) throw new Error("Runtime returned no session ID");
  await request("session/set_config_option", { sessionId, configId: "mode", value: "default" });
  await request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Read hello.txt. Write its contents to approved.txt, then run a command to print CERIUM-SHELL. Call the injected smoke MCP echo with CERIUM-MCP. Keep the reply short.",
      },
    ],
  });
  answer = "reject_once";
  await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Write DENIED to denied.txt with a file editing tool. Stop if denied." }],
  });
  const output = join(process.cwd(), "scratch", "captures");
  mkdirSync(output, { recursive: true });
  const file = join(output, `antigravity-${Date.now()}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  console.log(
    "Saved sanitized native traffic:",
    file,
    "Review before promoting to a fixture. Native session:",
    sessionId,
  );
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  const grace = setTimeout(() => child.kill(), 3000);
  grace.unref();
}
