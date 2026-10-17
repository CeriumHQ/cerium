// Records the SDK records of one small real Cursor session into test/fixtures, so the translator is
// tested against what @cursor/sdk actually emits rather than the synthetic fixture.
// Records two turns the way the session does (agent, `onDelta` updates, `run.wait()` results): a
// read + write with a call to an injected MCP server, then a turn cancelled at its first text.
//
// Usage (uses the Cursor SDK's login or CURSOR_API_KEY; a few cents):
//   node packages/adapters/cursor/scripts/record-fixture.ts [model-id] (default: composer-2.5)

import { Agent, Cursor, type Run } from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { toModelSelection } from "../src/models.ts";
import { toolRestrictions } from "../src/session.ts";
import type { CursorRecord } from "../src/translate.ts";

const workspace = mkdtempSync(join(tmpdir(), "cerium-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const model = toModelSelection(process.argv[2] ?? "composer-2.5", "low", await Cursor.models.list());
const mcpServers = {
  smoke: {
    type: "stdio" as const,
    command: process.execPath,
    args: [join(import.meta.dirname, "echo-mcp.ts")],
  },
};
// No setting sources: the user's own rules, hooks and servers stay out of the recording.
const agent = await Agent.create({
  model,
  local: { cwd: workspace, settingSources: [] },
  ...toolRestrictions("acceptEdits"),
});
const records: Array<CursorRecord> = [{ type: "agent", agentId: agent.agentId, model }];

const turn = async (text: string, cancelAtText = false) => {
  const id = randomUUID();
  let run: Run | undefined;
  let cancelRequested = false;
  run = await agent.send(text, {
    model,
    mcpServers,
    onDelta: ({ update }) => {
      records.push({ type: "update", turn: id, update });
      if (cancelAtText && !cancelRequested && update.type === "text-delta") {
        cancelRequested = true;
        void run?.cancel();
      }
    },
  });
  if (cancelRequested) await run.cancel();
  records.push({ type: "result", turn: id, result: await run.wait() });
};

await turn(
  "Read hello.txt, then create out.txt containing its contents in uppercase. Then call the `echo` tool " +
    "of the `smoke` MCP server with the text `cerium`. Finally reply with just the uppercase text.",
);
await turn("Write a 300-word story about a lighthouse keeper.", true);
await agent[Symbol.asyncDispose]();

// Fixtures are committed: scrub the local workspace path and username everywhere.
const escapeForJson = (value: string) => JSON.stringify(value).slice(1, -1);
const scrub = (line: string) =>
  line
    .replaceAll(escapeForJson(escapeForJson(workspace)), "<workspace>")
    .replaceAll(escapeForJson(workspace), "<workspace>")
    .replaceAll(userInfo().username, "<user>");

const fixtures = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(fixtures, { recursive: true });
writeFileSync(
  join(fixtures, "read-write-session.jsonl"),
  records.map((record) => scrub(JSON.stringify(record))).join("\n") + "\n",
);
console.log(`Recorded ${records.length} records from ${workspace}`);
