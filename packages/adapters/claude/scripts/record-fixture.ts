// Records the raw SDK message stream of one small real session into test/fixtures, so the
// translator is tested against what the installed `claude` actually emits.
//
// Usage (uses your logged-in Claude account; a few cents of Haiku):
//   node packages/adapters/claude/scripts/record-fixture.ts <path-to-claude-executable>

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const executable = process.argv[2];
if (executable === undefined) {
  console.error("Pass the path to the claude executable.");
  process.exit(1);
}

const workspace = mkdtempSync(join(tmpdir(), "cerium-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const messages: Array<SDKMessage | { type: "cerium_permission_request"; toolName: string; input: unknown }> =
  [];

const session = query({
  prompt:
    "Read hello.txt, then create out.txt containing its contents in uppercase. " +
    "Finally reply with just the uppercase text.",
  options: {
    pathToClaudeCodeExecutable: executable,
    cwd: workspace,
    model: "haiku",
    includePartialMessages: true,
    settingSources: [],
    disallowedTools: ["Agent", "Workflow", "SendMessage"],
    permissionMode: "default",
    canUseTool: async (toolName, input, { toolUseID }) => {
      messages.push({ type: "cerium_permission_request", toolName, input });
      return { behavior: "allow", updatedInput: input, toolUseID };
    },
  },
});

for await (const message of session) {
  messages.push(message);
}

// Fixtures are committed: keep only the fields the translator reads from account-level messages,
// and scrub the local workspace path and username everywhere else.
const pick = (record: object, keys: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => keys.includes(key)));

const sanitize = (message: (typeof messages)[number]): unknown => {
  if (message.type === "system" && message.subtype === "init") {
    return pick(message, ["type", "subtype", "session_id", "uuid", "model", "claude_code_version"]);
  }
  if (message.type === "rate_limit_event") {
    return {
      ...message,
      rate_limit_info: pick(message.rate_limit_info, ["status", "rateLimitType", "resetsAt"]),
    };
  }
  return message;
};

const escapeForJson = (text: string) => JSON.stringify(text).slice(1, -1);
const scrub = (line: string) =>
  line
    .replaceAll(escapeForJson(escapeForJson(workspace)), "<workspace>")
    .replaceAll(escapeForJson(workspace), "<workspace>")
    .replaceAll(userInfo().username, "<user>");

const fixtures = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(fixtures, { recursive: true });
writeFileSync(
  join(fixtures, "read-write-session.jsonl"),
  messages.map((message) => scrub(JSON.stringify(sanitize(message)))).join("\n") + "\n",
);
console.log(`Recorded ${messages.length} messages from ${workspace}`);
