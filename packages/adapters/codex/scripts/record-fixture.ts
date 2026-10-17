// Records the raw app-server messages of one small real session into test/fixtures, so the
// translator is tested against what the installed `codex` actually sends.
//
// Usage (uses your logged-in Codex account; one short turn on the cheapest model):
//   node packages/adapters/codex/scripts/record-fixture.ts <path-to-codex-executable> [--unelevated-sandbox]
//
// `--unelevated-sandbox` runs Codex's Windows sandbox unelevated for this recording only, for machines
// where the elevated sandbox's setup refresh fails (seen while the Codex desktop app's computer-use
// helper holds a runtime DLL open: every command then fails with "setup refresh had errors").

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { threadParams } from "../src/config.ts";

const executable = process.argv[2];
if (executable === undefined) {
  console.error("Pass the path to the codex executable.");
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "cerium-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const sandboxArgs = process.argv.includes("--unelevated-sandbox")
  ? ["-c", 'windows.sandbox="unelevated"']
  : [];
const child = spawn(executable, ["app-server", ...sandboxArgs], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "inherit"],
});
const received: Array<Record<string, unknown>> = [];
const pending = new Map<number, (message: Record<string, unknown>) => void>();
let nextId = 1;
let turnDone: (() => void) | undefined;

const write = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
const request = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) =>
      message.error === undefined
        ? resolve(message.result as Record<string, unknown>)
        : reject(message.error),
    );
    write({ id, method, params });
  });

createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  received.push(message);
  if (typeof message.method === "string" && message.id !== undefined) {
    // Approve everything once: the fixture is a session where the user said yes.
    const result =
      message.method === "mcpServer/elicitation/request"
        ? { action: "accept", content: null, _meta: null }
        : { decision: "accept" };
    write({ id: message.id, result });
  } else if (message.method === undefined && typeof message.id === "number") {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "turn/completed") {
    turnDone?.();
  }
});

await request("initialize", {
  clientInfo: { name: "cerium", title: "Cerium", version: "0.0.0" },
  capabilities: { experimentalApi: false, requestAttestation: false },
});
write({ method: "initialized" });

const options = {
  cwd: workspace,
  model: "gpt-6-luna",
  access: "ask",
  mcpServers: {},
  includeUserMcpServers: false,
} as const;
const { config } = await request("config/read", { cwd: workspace });
const userConfig = config as { mcp_servers?: Record<string, unknown> | null };
// Ephemeral, so the recording leaves no thread in the user's Codex history.
const started = await request("thread/start", {
  ...threadParams(options, { mcpServers: Object.keys(userConfig.mcp_servers ?? {}) }, "low"),
  ephemeral: true,
});
const threadId = (started.thread as { id: string }).id;

const completed = new Promise<void>((resolve) => (turnDone = resolve));
await request("turn/start", {
  threadId,
  input: [
    {
      type: "text",
      text:
        "Read hello.txt, then use apply_patch to create out.txt containing its contents in uppercase. " +
        "Finally reply with just the uppercase text.",
      text_elements: [],
    },
  ],
});
await completed;
child.kill();

// Fixtures are committed: drop messages that describe the machine or account, and scrub the local
// workspace path, username and host name everywhere else.
const DROPPED = new Set(["remoteControl/status/changed", "account/updated", "account/rateLimits/updated"]);
const kept = received.filter(
  (message) =>
    !DROPPED.has(message.method as string) &&
    // The `config/read` response carries the user's whole config.
    !(message.method === undefined && (message.result as { config?: unknown } | undefined)?.config),
);

const escapeForJson = (text: string) => JSON.stringify(text).slice(1, -1);
const scrub = (line: string) =>
  line
    .replaceAll(escapeForJson(workspace), "<workspace>")
    .replaceAll(workspace, "<workspace>")
    .replaceAll(userInfo().username, "<user>")
    .replaceAll(hostname(), "<host>");

const fixtures = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(fixtures, { recursive: true });
writeFileSync(
  join(fixtures, "read-write-session.jsonl"),
  kept.map((message) => scrub(JSON.stringify(message))).join("\n") + "\n",
);
console.log(`Recorded ${kept.length} of ${received.length} messages from ${workspace}`);
