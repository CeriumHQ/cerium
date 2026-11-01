// Live end-to-end check of the Grok Build adapter on the user's signed-in Grok (`grok login`).
// Prints the probe, the models, the plan's usage and the skills, then runs one session in Cerium's
// "ask" access, allowing each approval:
//   1. read + edit + a command, and a call to an injected MCP server,
//   2. after an effort switch, a story with a side question asked (`/btw`) at its first text, then
//      interrupted,
//   3. a compaction,
//   4. the session resumed and asked about turn 1.
// Then a one-off completion (a thread title), and the session read back as a past one, which shouldn't
// hold the side question. The session is deleted from Grok's history at the end.
//
// Usage: node packages/adapters/grok/scripts/smoke.ts [model-id] (default: Grok's own default)

import type { AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrokAdapter } from "../src/index.ts";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "cerium-smoke-")));
writeFileSync(join(workspace, "hello.txt"), "hello from cerium\n");
const SIDE_QUESTION = "Which file did you read first in this conversation? Reply with just its name.";

/** Reads a session's events, allowing each approval, and runs turns on it one at a time. */
const drive = Effect.fn("drive")(function* (
  session: AgentSession,
  /** Called once at the first text of a turn started with `atText`. */
  onText: () => Effect.Effect<void, unknown>,
) {
  const agentId = yield* Deferred.make<string>();
  let turnDone = yield* Deferred.make<void>();
  let atText = false;
  yield* session.events.pipe(
    Stream.runForEach(({ payload }) =>
      Effect.gen(function* () {
        if (payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta") {
          if (payload._tag === "MessageDelta" && atText) {
            atText = false;
            yield* onText().pipe(Effect.ignore, Effect.forkScoped);
          }
          return;
        }
        yield* Console.log("event:", JSON.stringify(payload));
        if (payload._tag === "SessionStarted") yield* Deferred.succeed(agentId, payload.providerSessionId);
        if (payload._tag === "PermissionRequested") {
          yield* session.respondToPermission(payload.requestId, { decision: "allow", scope: "once" });
        }
        if (payload._tag === "TurnCompleted") yield* Deferred.succeed(turnDone, undefined);
      }),
    ),
    Effect.forkScoped,
  );
  const run = (start: Effect.Effect<void, unknown>, label: string, withText = false) =>
    Effect.gen(function* () {
      turnDone = yield* Deferred.make<void>();
      atText = withText;
      yield* Console.log(`--- ${label}`);
      yield* start;
      yield* Deferred.await(turnDone);
    });
  return { agentId: Deferred.await(agentId), run };
});

const program = Effect.gen(function* () {
  const adapter = yield* GrokAdapter;
  const probe = yield* adapter.probe;
  yield* Console.log("probe:", JSON.stringify(probe));
  if (probe._tag !== "HarnessInstalled") return;
  const models = yield* adapter.listModels;
  yield* Console.log(`models (${models.length}):`);
  for (const info of models) {
    yield* Console.log(
      `  ${info.id} [${info.efforts.join(", ")}] ${info.label}${info.isDefault ? " (default)" : ""}`,
    );
  }
  yield* Console.log("usage:", JSON.stringify(yield* adapter.usage!));
  const skills = yield* adapter.listSkills!(workspace);
  yield* Console.log(`skills (${skills.length}):`, skills.map((skill) => skill.name).join(", "));

  const model = process.argv[2] ?? models.find((info) => info.isDefault)?.id ?? models[0]!.id;
  const options: SessionOptions = {
    cwd: workspace,
    model,
    effort: "medium",
    access: "ask",
    mcpServers: {
      smoke: {
        type: "stdio",
        command: process.execPath,
        args: [join(import.meta.dirname, "..", "..", "cursor", "scripts", "echo-mcp.ts")],
      },
    },
    includeUserMcpServers: false,
    trustedMcpServers: ["smoke"],
    appendSystemPrompt: "Keep every reply as short as the task allows.",
  };

  const first = yield* Scope.make();
  const session = yield* adapter.startSession(options).pipe(Scope.provide(first));
  let sessionId = "";
  const { agentId, run } = yield* drive(session, () =>
    adapter.sideQuestion!({
      model,
      cwd: workspace,
      sessionId,
      instructions: "Answer from the conversation so far.",
      prompt: SIDE_QUESTION,
    }).pipe(
      Effect.tap((answer) => Console.log("side answer:", JSON.stringify(answer))),
      Effect.tapError((error) => Console.log("side question failed:", String(error))),
      Effect.ensuring(session.interrupt.pipe(Effect.ignore)),
    ),
  ).pipe(Scope.provide(first));
  yield* run(
    session.send(
      "Read hello.txt, then replace the word hello with goodbye in it, then run the command " +
        "`git --version`, then call the echo tool of the smoke MCP server with the text cerium. " +
        "Finally reply DONE.",
    ),
    "turn 1: read, edit, command, MCP",
  );
  sessionId = yield* agentId;
  yield* Console.log("hello.txt:", JSON.stringify(readFileSync(join(workspace, "hello.txt"), "utf8")));
  yield* session.setEffort("low");
  yield* run(
    session.send("Write a 200-word story about a lighthouse keeper."),
    "turn 2: low effort, side question, interrupt",
    true,
  );
  yield* run(session.compact!, "turn 3: compact");
  yield* Scope.close(first, Exit.void);

  yield* Console.log(`--- resuming ${sessionId}`);
  const resumed = yield* adapter.startSession({ ...options, resume: sessionId });
  const again = yield* drive(resumed, () => Effect.void);
  yield* again.run(
    resumed.send("What did you replace hello with in hello.txt? Reply with just the word."),
    "turn 4: resumed",
  );

  yield* Console.log("--- completion");
  const title = yield* adapter.complete({
    model,
    cwd: workspace,
    instructions: "You write short titles for coding conversations. Reply with the title only.",
    prompt: "Fix the login bug in auth.ts where the session cookie expires too early",
    onUsage: (usage) => console.log("completion usage:", JSON.stringify(usage)),
  });
  yield* Console.log("title:", JSON.stringify(title));

  const listed = (yield* adapter.listSessions!).find((each) => each.id === sessionId);
  yield* Console.log("listed:", JSON.stringify(listed));
  if (listed !== undefined) {
    const history = yield* adapter.readSession!(listed);
    yield* Console.log(`history: ${history.turns.length} turns`);
    for (const turn of history.turns) yield* Console.log(`  ${JSON.stringify(turn.prompt.slice(0, 80))}`);
    const leaked = JSON.stringify(history).includes(SIDE_QUESTION);
    yield* Console.log(leaked ? "side question: IN HISTORY" : "side question: not in history");
  }

  // The smoke session is the script's own: nothing of it stays in the user's Grok history.
  execFileSync(probe.executablePath, ["sessions", "delete", sessionId], {
    stdio: "inherit",
    shell: /\.cmd$/i.test(probe.executablePath),
  });
}).pipe(Effect.scoped, Effect.provide(GrokAdapter.layer.pipe(Layer.provide(NodeServices.layer))));

NodeRuntime.runMain(program);
