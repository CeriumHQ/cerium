// Live fork check: for each harness that forks sessions, a real two-turn conversation is forked
// before its second turn and asked what it remembers. It passes when the fork holds the first turn
// and not the second. Uses the logged-in harness accounts; each harness has a deadline.
//
// Usage: node apps/backend/scripts/live-fork.ts [--providers=claude,codex,opencode] [--model=codex:gpt-6-luna]

import type { AgentSession, HarnessAdapter } from "@cerium/harness";
import { Adapters } from "@cerium/orchestrator";
import type { ProviderId } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Queue, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdaptersLive } from "../src/layers.ts";

const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const providers = flag("providers")?.split(",") as ReadonlyArray<ProviderId> | undefined;
const models = Object.fromEntries(
  (flag("model")?.split(",") ?? []).map((pair) => pair.split(":") as [string, string]),
);

/** Cheap, quick models, tried before each harness's default. */
const preferred: Partial<Record<ProviderId, RegExp>> = {
  claude: /haiku/i,
  codex: /mini|spark/i,
  opencode: /big-pickle|free/i,
};

/** A session whose turns can be awaited, each resolving with its reply. */
const converse = (session: AgentSession) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<string>();
    let sessionId: string | undefined;
    let reply = "";
    yield* session.events.pipe(
      Stream.runForEach(({ payload }) =>
        Effect.gen(function* () {
          if (payload._tag === "SessionStarted") sessionId = payload.providerSessionId;
          if (payload._tag === "MessageCompleted") reply = payload.text;
          if (payload._tag === "PermissionRequested") {
            yield* session.respondToPermission(payload.requestId, { decision: "deny", scope: "once" });
          }
          if (payload._tag === "TurnCompleted") {
            yield* Queue.offer(replies, reply);
            reply = "";
          }
        }),
      ),
      Effect.forkScoped,
    );
    const ask = (text: string, turnId: string) =>
      session.send(text, { turnId }).pipe(Effect.andThen(Queue.take(replies)));
    return { ask, sessionId: () => sessionId };
  });

const check = (adapter: HarnessAdapter) =>
  Effect.gen(function* () {
    if (adapter.fork === undefined) return `${adapter.provider}: no fork`;
    const cwd = mkdtempSync(join(tmpdir(), `cerium-fork-${adapter.provider}-`));
    const listed = yield* adapter.listModels;
    const model =
      models[adapter.provider] ??
      (listed.find((each) => preferred[adapter.provider]?.test(each.id)) ??
        listed.find((each) => each.isDefault) ??
        listed[0])!.id;
    // Nothing asks for a tool, so the access only needs to start a session.
    const options = { cwd, model, access: "auto" as const, mcpServers: {}, includeUserMcpServers: false };

    const second = randomUUID();
    const sessionId = yield* Effect.scoped(
      Effect.gen(function* () {
        const first = yield* converse(yield* adapter.startSession(options));
        yield* first.ask("Remember the word apple. Reply with just: ok", randomUUID());
        yield* first.ask("Also remember the word banana. Reply with just: ok", second);
        return first.sessionId();
      }),
    );
    if (sessionId === undefined) return `${adapter.provider}: FAIL, no session id`;

    const forked = yield* adapter.fork({ cwd, sessionId, before: { id: second, index: 1 } });
    const answer = yield* Effect.scoped(
      Effect.gen(function* () {
        const resumed = yield* converse(yield* adapter.startSession({ ...options, resume: forked }));
        return yield* resumed.ask(
          "Which words did I ask you to remember? Reply with just the words, lowercase.",
          randomUUID(),
        );
      }),
    );
    const passed = /apple/.test(answer.toLowerCase()) && !/banana/.test(answer.toLowerCase());
    return `${adapter.provider} (${model}): ${passed ? "PASS" : "FAIL"} ${sessionId} -> ${forked}, replied "${answer.trim()}"`;
  }).pipe(
    Effect.timeout("240 seconds"),
    Effect.catchCause((cause) => Effect.succeed(`${adapter.provider}: FAIL ${String(cause).slice(0, 600)}`)),
  );

const lines = await Effect.runPromise(
  Effect.gen(function* () {
    const adapters = yield* Adapters;
    const chosen = [...adapters.values()].filter(
      (adapter) =>
        adapter.fork !== undefined && (providers === undefined || providers.includes(adapter.provider)),
    );
    return yield* Effect.forEach(chosen, check, { concurrency: "unbounded" });
  }).pipe(Effect.provide(AdaptersLive.pipe(Layer.provide(NodeServices.layer)))),
);
console.log(lines.join("\n"));
// Harness processes a timed-out check left behind must not keep this one alive.
process.exit(lines.every((line) => line.includes("PASS")) ? 0 : 1);
