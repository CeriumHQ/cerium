// Records the server events of one small real OpenCode session into test/fixtures, so the translator
// is tested against what `opencode serve` actually emits. Records two turns the way the session does
// (its own events, from a subscription opened before the session): a read, a write, a command and a
// call to an injected MCP server, with each approval answered once; then a turn interrupted at its
// first text.
//
// Usage (the free model needs no sign-in):
//   node packages/adapters/opencode/scripts/record-fixture.ts [provider/model] (default: opencode/big-pickle)

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { OpenCodeEvent } from "@opencode/client";
import { Deferred, Effect, Option, Stream } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { call, openHost } from "../src/host.ts";
import { parseModel } from "../src/models.ts";
import { sessionRules, toMcpServer } from "../src/policy.ts";
import { findOpenCodeExecutable } from "../src/probe.ts";
import type { OpenCodeRecord } from "../src/translate.ts";

const model = process.argv[2] ?? "opencode/big-pickle";
const workspace = mkdtempSync(join(tmpdir(), "cerium-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const program = Effect.gen(function* () {
  const executable = yield* findOpenCodeExecutable;
  if (Option.isNone(executable)) return yield* Effect.die(new Error("opencode is not installed"));
  const smoke = {
    type: "stdio" as const,
    command: process.execPath,
    args: [join(import.meta.dirname, "..", "..", "cursor", "scripts", "echo-mcp.ts")],
  };
  const { client } = yield* openHost(executable.value, {
    cwd: workspace,
    config: { mcp: { servers: { smoke: toMcpServer(smoke) } } },
  });

  const records: Array<OpenCodeRecord> = [];
  let sessionId: string | undefined;
  let turnEnded = yield* Deferred.make<void>();
  let onText: (() => void) | undefined;
  const connected = yield* Deferred.make<void>();

  yield* Stream.fromAsyncIterable(client.event.subscribe(), (cause) => cause).pipe(
    Stream.runForEach((event: OpenCodeEvent) =>
      Effect.gen(function* () {
        if (event.type === "server.connected") return yield* Deferred.succeed(connected, undefined);
        const data: unknown = event.data;
        const owner =
          typeof data === "object" && data !== null ? (data as { sessionID?: unknown }).sessionID : undefined;
        if (sessionId === undefined || owner !== sessionId) return;
        records.push({ type: "event", event });
        if (event.type === "permission.asked") {
          yield* call("answer", (signal) =>
            client.permission.reply(
              { sessionID: sessionId!, requestID: event.data.id, decision: "once" },
              { signal },
            ),
          ).pipe(Effect.ignore);
        }
        if (event.type === "session.text.delta") onText?.();
        if (event.type.startsWith("session.execution.") && event.type !== "session.execution.started") {
          yield* Deferred.succeed(turnEnded, undefined);
        }
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Deferred.await(connected);

  const ref = parseModel(model);
  if (ref === undefined) return yield* Effect.die(new Error(`not a provider/model: ${model}`));
  const session = yield* call("start a session", (signal) =>
    client.session.create(
      { location: { directory: workspace }, model: ref, permissions: sessionRules("ask", ["smoke"]) },
      { signal },
    ),
  );
  sessionId = session.id;
  records.push({ type: "opened", sessionId: session.id, model });

  const turn = (text: string, interruptAtText = false) =>
    Effect.gen(function* () {
      turnEnded = yield* Deferred.make<void>();
      onText = interruptAtText
        ? () => {
            onText = undefined;
            void client.session.interrupt({ sessionID: session.id });
          }
        : undefined;
      yield* call("send the message", (signal) =>
        client.session.prompt({ sessionID: session.id, text }, { signal }),
      );
      yield* Deferred.await(turnEnded).pipe(Effect.timeout("3 minutes"));
    });

  yield* turn(
    "Read hello.txt, then create out.txt containing its contents in uppercase. Then run the command " +
      '`node -e "console.log(1 + 1)"`. Then call the `echo` tool of the `smoke` MCP server with the text ' +
      "`cerium`. Finally reply with just the uppercase text.",
  );
  yield* turn("Write a 300-word story about a lighthouse keeper.", true);
  return records;
}).pipe(Effect.scoped);

// Fixtures are committed: scrub the local workspace path, home folder and username everywhere.
const escapeForJson = (value: string) => JSON.stringify(value).slice(1, -1);
const scrub = (line: string) =>
  [workspace, homedir()]
    .reduce(
      (text, path, index) =>
        text
          .replaceAll(escapeForJson(escapeForJson(path)), index === 0 ? "<workspace>" : "<home>")
          .replaceAll(escapeForJson(path), index === 0 ? "<workspace>" : "<home>"),
      line,
    )
    .replaceAll(userInfo().username, "<user>");

NodeRuntime.runMain(
  program.pipe(
    Effect.tap((records) =>
      Effect.sync(() => {
        const fixtures = join(import.meta.dirname, "..", "test", "fixtures");
        mkdirSync(fixtures, { recursive: true });
        writeFileSync(
          join(fixtures, "read-write-session.jsonl"),
          records.map((record) => scrub(JSON.stringify(record))).join("\n") + "\n",
        );
        console.log(`Recorded ${records.length} records from ${workspace}`);
      }),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
