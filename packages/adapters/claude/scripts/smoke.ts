// Live end-to-end check of the Claude adapter against the user's installed, logged-in `claude`.
// Runs two short Haiku turns (a read + an approved write, then a reply after an effort switch)
// and prints the canonical events and per-turn usage.
//
// Usage: node packages/adapters/claude/scripts/smoke.ts

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Fiber, Stream } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../src/index.ts";

const workspace = mkdtempSync(join(tmpdir(), "cerium-smoke-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const program = Effect.gen(function* () {
  const adapter = yield* ClaudeAdapter;
  yield* Console.log("probe:", JSON.stringify(yield* adapter.probe));

  const session = yield* adapter.startSession({
    cwd: workspace,
    model: "haiku",
    effort: "medium",
    access: "ask",
    mcpServers: {},
    includeUserMcpServers: false,
  });

  let turnDone = yield* Deferred.make<void>();
  const usage: Array<unknown> = [];

  const consumer = yield* session.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const { payload } = event;
        if (payload._tag !== "MessageDelta") yield* Console.log("event:", JSON.stringify(payload));
        if (payload._tag === "PermissionRequested") {
          yield* session.respondToPermission(payload.requestId, { decision: "allow", scope: "once" });
        }
        if (payload._tag === "UsageReported") usage.push(payload);
        if (payload._tag === "TurnCompleted") yield* Deferred.succeed(turnDone, undefined);
      }),
    ),
    Effect.forkChild,
  );

  yield* session.send(
    "Read hello.txt, then create out.txt containing its contents in uppercase. Reply with just the uppercase text.",
  );
  yield* Deferred.await(turnDone);

  turnDone = yield* Deferred.make<void>();
  yield* session.setEffort("low");
  yield* session.send("Reply with just the word OK.");
  yield* Deferred.await(turnDone);

  yield* Console.log("usage per turn:", JSON.stringify(usage, null, 2));
  yield* Fiber.interrupt(consumer);
}).pipe(Effect.scoped, Effect.provide(ClaudeAdapter.layer), Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
