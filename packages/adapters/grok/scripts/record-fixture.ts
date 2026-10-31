// Records one small real Grok Build session into test/fixtures, so the translator is tested against what
// `grok agent stdio` actually sends. Needs a signed-in `grok` (`grok login`) and spends a little of the
// plan. The session reads a file, writes one (approved), calls an injected stdio MCP server, and is then
// interrupted at its first text. The recording replaces nothing: the contract tests run over every
// `.jsonl` in the folder, and `grok-session.jsonl` (hand-built from Grok's source) can then be retired.
//
// Usage (from the repo root): node packages/adapters/grok/scripts/record-fixture.ts [model]

import { FixtureRecorder, startAcpSession } from "@cerium/adapter-acp";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Option, Stream } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGrokExecutable, grokHarness, probeGrok } from "../src/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "cerium-grok-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const program = Effect.gen(function* () {
  const executable = yield* findGrokExecutable;
  if (Option.isNone(executable)) return yield* Effect.die(new Error("grok is not installed"));
  const status = yield* probeGrok;
  if (status._tag !== "HarnessInstalled" || status.auth._tag !== "LoggedIn") {
    return yield* Effect.die(new Error("Grok Build is signed out: run `grok login` first"));
  }
  const recorder = new FixtureRecorder();
  const session = yield* startAcpSession(
    grokHarness,
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
    { record: recorder.frame },
  );

  let turnEnded = yield* Deferred.make<void>();
  let onText: (() => void) | undefined;
  yield* session.events.pipe(
    Stream.runForEach(({ payload }) =>
      Effect.gen(function* () {
        if (payload._tag === "SessionStarted") recorder.opened(payload.providerSessionId, payload.model);
        if (payload._tag === "PermissionRequested") {
          yield* session.respondToPermission(payload.requestId, { decision: "allow", scope: "once" });
        }
        if (payload._tag === "MessageDelta" && onText !== undefined) {
          const stop = onText;
          onText = undefined;
          stop();
        }
        if (payload._tag === "TurnCompleted") yield* Deferred.succeed(turnEnded, undefined);
      }),
    ),
    Effect.forkScoped,
  );
  const turn = (text: string) =>
    Effect.gen(function* () {
      turnEnded = yield* Deferred.make<void>();
      yield* session.send(text);
      yield* Deferred.await(turnEnded).pipe(Effect.timeout("5 minutes"));
    });

  yield* turn(
    "Read hello.txt, then create out.txt containing exactly `smoke ok`, then run `ls`, then call the smoke server's echo tool with the text `ping`. Reply in one line.",
  );
  turnEnded = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  onText = () => Deferred.doneUnsafe(interrupted, Effect.void);
  yield* session.send("Count from 1 to 300, one number per line.");
  yield* Deferred.await(interrupted).pipe(Effect.timeout("2 minutes"));
  yield* session.interrupt;
  yield* Deferred.await(turnEnded).pipe(Effect.timeout("1 minute"));

  const folder = join(import.meta.dirname, "..", "test", "fixtures");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `recorded-${status.version}.jsonl`);
  writeFileSync(file, recorder.jsonl());
  yield* Console.log(`Recorded ${recorder.records.length} records to ${file}`);
}).pipe(Effect.scoped);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
