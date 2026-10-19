// Records the MSP frames of one small real session into test/fixtures, so the translator is tested
// against what the installed `muse` actually sends. Runs through the adapter's own session code and
// approves every request once.
//
// Usage (from the repo root):
//   node packages/adapters/muse/scripts/record-fixture.ts          a read + approved write on the
//                                                                  logged-in account's default model
//   node packages/adapters/muse/scripts/record-fixture.ts --echo   two turns on Muse's offline `echo`
//                                                                  provider; needs no account
//   node packages/adapters/muse/scripts/record-fixture.ts --todos  a two-item todo list on the logged-in
//                                                                  account's default model

import type { AdapterEvent } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Option, Stream } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { findMuseExecutable, listMuseModels, startMuseSession } from "../src/index.ts";
import type { RecordedFrame } from "../src/session.ts";

const echo = process.argv.includes("--echo");
const todos = process.argv.includes("--todos");
const workspace = mkdtempSync(join(tmpdir(), "cerium-fixture-"));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");

const prompts = echo
  ? ["hello echo", "second turn"]
  : todos
    ? [
        "First write a todo list with your todo tool, with exactly two items: list the working directory " +
          "with a command, and reply with DONE. Then do each item, updating the list as you start and " +
          "finish it.",
      ]
    : [
        "Read hello.txt, then create out.txt containing its contents in uppercase. " +
          "Finally reply with just the uppercase text.",
      ];

const frames: Array<RecordedFrame> = [];

const program = Effect.gen(function* () {
  const executable = yield* findMuseExecutable;
  if (Option.isNone(executable)) return yield* Effect.die("Muse Code is not installed.");
  const model = echo
    ? "echo"
    : ((yield* listMuseModels(executable.value)).find((entry) => entry.isDefault)?.id ?? "");
  const session = yield* startMuseSession(
    executable.value,
    { cwd: workspace, model, access: "ask", mcpServers: {}, includeUserMcpServers: false },
    { ...(echo ? { provider: "echo" as const } : {}), record: (frame) => frames.push(frame) },
  );

  let turnDone = yield* Deferred.make<void>();
  const onEvent = ({ payload }: AdapterEvent) =>
    Effect.gen(function* () {
      if (payload._tag === "PermissionRequested") {
        yield* session.respondToPermission(payload.requestId, { decision: "allow", scope: "once" });
      }
      if (payload._tag === "TurnCompleted") yield* Deferred.succeed(turnDone, undefined);
    });
  yield* session.events.pipe(Stream.runForEach(onEvent), Effect.forkScoped);

  for (const prompt of prompts) {
    yield* session.send(prompt);
    yield* Deferred.await(turnDone).pipe(Effect.timeout("3 minutes"));
    turnDone = yield* Deferred.make<void>();
  }
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// Fixtures are committed: scrub the local workspace path and username everywhere.
const escapeForJson = (text: string) => JSON.stringify(text).slice(1, -1);
const scrub = (line: string) =>
  line
    .replaceAll(escapeForJson(escapeForJson(workspace)), "<workspace>")
    .replaceAll(escapeForJson(workspace), "<workspace>")
    .replaceAll(userInfo().username, "<user>");

const write = Effect.sync(() => {
  const fixtures = join(import.meta.dirname, "..", "test", "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const name = echo ? "echo-session.jsonl" : todos ? "todo-session.jsonl" : "read-write-session.jsonl";
  writeFileSync(join(fixtures, name), frames.map((frame) => scrub(JSON.stringify(frame))).join("\n") + "\n");
  return name;
});

NodeRuntime.runMain(
  program.pipe(
    Effect.andThen(write),
    Effect.flatMap((name) => Console.log(`Recorded ${frames.length} frames into ${name} from ${workspace}`)),
  ),
);
