// Live end-to-end check of the Cursor adapter: a local SDK agent on the user's Cursor account.
// Needs the SDK's login (Settings → Harnesses → Sign in, or `CursorAdapter.login`) or CURSOR_API_KEY.
// Prints the probe and the model list, then runs four short turns on one model:
//   1. read + write (acceptEdits) and a call to an injected MCP server,
//   2. a reply after an effort switch,
//   3. a turn interrupted at its first text,
//   4. a resumed session asked about turn 1.
//
// Usage: node packages/adapters/cursor/scripts/smoke.ts [model-id] (default: composer-2.5)

import type { AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CursorAdapter } from "../src/index.ts";

const model = process.argv[2] ?? "composer-2.5";
const workspace = mkdtempSync(join(tmpdir(), "cerium-smoke-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

/** Reads a session's single-consumer event stream and runs turns on it one at a time. */
const drive = Effect.fn("drive")(function* (session: AgentSession) {
  const agentId = yield* Deferred.make<string>();
  let turnDone = yield* Deferred.make<void>();
  let interruptAtText = false;
  yield* session.events.pipe(
    Stream.runForEach(({ payload }) =>
      Effect.gen(function* () {
        if (payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta") {
          if (payload._tag === "MessageDelta" && interruptAtText) {
            interruptAtText = false;
            yield* session.interrupt.pipe(Effect.ignore);
          }
          return;
        }
        yield* Console.log("event:", JSON.stringify(payload));
        if (payload._tag === "SessionStarted") yield* Deferred.succeed(agentId, payload.providerSessionId);
        if (payload._tag === "TurnCompleted") yield* Deferred.succeed(turnDone, undefined);
      }),
    ),
    Effect.forkScoped,
  );
  const turn = (text: string, interrupt = false) =>
    Effect.gen(function* () {
      turnDone = yield* Deferred.make<void>();
      interruptAtText = interrupt;
      yield* Console.log(`--- turn: ${text}`);
      yield* session.send(text);
      yield* Deferred.await(turnDone);
    });
  return { agentId: Deferred.await(agentId), turn };
});

const program = Effect.gen(function* () {
  const adapter = yield* CursorAdapter;
  yield* Console.log("probe:", JSON.stringify(yield* adapter.probe));
  const models = yield* adapter.listModels;
  yield* Console.log(`models (${models.length}):`);
  for (const info of models) yield* Console.log(`  ${info.id} [${info.efforts.join(", ")}] ${info.label}`);

  const options: SessionOptions = {
    cwd: workspace,
    model,
    effort: "medium",
    access: "acceptEdits",
    mcpServers: {
      smoke: { type: "stdio", command: process.execPath, args: [join(import.meta.dirname, "echo-mcp.ts")] },
    },
    includeUserMcpServers: false,
    trustedMcpServers: ["smoke"],
    appendSystemPrompt: "Keep every reply as short as the task allows.",
  };

  const first = yield* Scope.make();
  const session = yield* adapter.startSession(options).pipe(Scope.provide(first));
  const { agentId, turn } = yield* drive(session).pipe(Scope.provide(first));
  yield* turn(
    "Read hello.txt, then create out.txt containing its contents in uppercase. Then call the `echo` tool " +
      "of the `smoke` MCP server with the text `cerium`. Finally reply with just the uppercase text.",
  );
  const out = join(workspace, "out.txt");
  yield* Console.log("out.txt:", existsSync(out) ? JSON.stringify(readFileSync(out, "utf8")) : "(missing)");
  yield* session.setEffort("low");
  yield* turn("Reply with just the word OK.");
  yield* turn("Write a 300-word story about a lighthouse keeper.", true);
  const resume = yield* agentId;
  yield* Scope.close(first, Exit.void);

  yield* Console.log(`--- resuming ${resume}`);
  const resumed = yield* adapter.startSession({ ...options, resume });
  const again = yield* drive(resumed);
  yield* again.turn("What text did you write into out.txt? Reply with just that text.");
}).pipe(Effect.scoped, Effect.provide(CursorAdapter.layer.pipe(Layer.provide(NodeServices.layer))));

NodeRuntime.runMain(program);
