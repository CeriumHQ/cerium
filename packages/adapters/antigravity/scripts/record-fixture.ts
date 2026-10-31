// Records one real Antigravity CLI run into test/fixtures, so the translator is tested against what
// `agy --output-format stream-json` actually prints. Needs a signed-in `agy`. The run reads a file,
// writes one (Cerium's hook approves it), runs `ls` and calls an injected stdio MCP server. The contract
// tests run over every `.jsonl` in the folder.
//
// Usage (from the repo root): node packages/adapters/antigravity/scripts/record-fixture.ts [model]

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Option, Stream } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultGeminiHome,
  findAntigravityExecutable,
  probeAntigravity,
  startAntigravitySession,
  type AgyEvent,
} from "../src/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "cerium-agy-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const program = Effect.gen(function* () {
  const executable = yield* findAntigravityExecutable;
  if (Option.isNone(executable)) return yield* Effect.die(new Error("agy is not installed"));
  const status = yield* probeAntigravity(defaultGeminiHome());
  if (status._tag !== "HarnessInstalled" || status.auth._tag !== "LoggedIn") {
    return yield* Effect.die(new Error("Antigravity CLI is signed out: run `agy` and sign in first"));
  }
  const lines: Array<AgyEvent> = [];
  const session = yield* startAntigravitySession(
    executable.value,
    {
      cwd: workspace,
      model: process.argv[2] ?? "",
      access: "ask",
      mcpServers: {
        smoke: {
          type: "stdio",
          command: process.execPath,
          args: [join(import.meta.dirname, "..", "..", "cursor", "scripts", "echo-mcp.ts")],
        },
      },
      includeUserMcpServers: false,
    },
    { record: (record) => void (record.type === "event" && lines.push(record.event)) },
  );
  const ended = yield* Deferred.make<void>();
  yield* session.events.pipe(
    Stream.runForEach(({ payload }) =>
      Effect.gen(function* () {
        yield* Console.log(JSON.stringify(payload).slice(0, 240));
        if (payload._tag === "PermissionRequested") {
          yield* session.respondToPermission(payload.requestId, { decision: "allow", scope: "once" });
        }
        if (payload._tag === "TurnCompleted") yield* Deferred.succeed(ended, undefined);
      }),
    ),
    Effect.forkScoped,
  );
  yield* session.send(
    "Read hello.txt, then create out.txt containing exactly `smoke ok`, then run `ls`, then call the smoke server's echo tool with the text `ping`. Reply in one line.",
  );
  yield* Deferred.await(ended).pipe(Effect.timeout("5 minutes"));
  const folder = join(import.meta.dirname, "..", "test", "fixtures");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `recorded-${status.version}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  yield* Console.log(`Recorded ${lines.length} lines to ${file}`);
}).pipe(Effect.scoped);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
