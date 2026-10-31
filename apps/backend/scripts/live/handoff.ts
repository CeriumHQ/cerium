// Live handoff check: a thread's lead handed from one real harness to another and back, through this
// checkout's orchestrator and adapters, on the logged-in harness accounts. The first harness is told a
// code word; after each handoff the new session must say it back, so it passes only when the
// conversation really crossed over. Every step has a deadline and the process always exits.
//
// Usage: node apps/backend/scripts/live/handoff.ts [--from=claude] [--to=codex]
//          [--model=claude:haiku,codex:gpt-5.4-mini] [--timeout=180]

import { Store } from "@cerium/store";
import {
  Adapters,
  BusEndpoint,
  Catalog,
  Checkpoints,
  Orchestrator,
  OrchestratorConfig,
  ProjectScripts,
  UserSettings,
  Worktrees,
} from "@cerium/orchestrator";
import type { AgentEvent, AgentId, ProviderId } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { Duration, Effect, Layer, Stream } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdaptersLive } from "../../src/layers.ts";

const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

if (process.argv.includes("--help")) {
  console.log(
    [
      "node apps/backend/scripts/live/handoff.ts [options]",
      "  --from=claude                   the harness the thread starts on",
      "  --to=codex                      the harness it is handed to, and then back from",
      "  --model=claude:haiku,codex:…    a model per provider (default: each one's quick model)",
      "  --timeout=180                   seconds per turn",
    ].join("\n"),
  );
  process.exit(0);
}

const from = (flag("from") ?? "claude") as ProviderId;
const to = (flag("to") ?? "codex") as ProviderId;
const picked = Object.fromEntries(
  (flag("model") ?? "")
    .split(",")
    .filter((pair) => pair.includes(":"))
    .map((pair) => pair.split(":") as [string, string]),
) as Partial<Record<ProviderId, string>>;
const turnTimeout = Duration.seconds(Number(flag("timeout") ?? 180));

/** Quick models each harness offers, tried before its default. */
const quick: Partial<Record<ProviderId, RegExp>> = {
  claude: /haiku/i,
  codex: /mini|spark|luna/i,
  cursor: /composer|auto/i,
  opencode: /big-pickle|free/i,
  muse: /fast|lite|mini/i,
  grok: /build|fast|mini/i,
};

const CODE = "PELICAN-42";

const data = mkdtempSync(join(tmpdir(), "cerium-handoff-"));

/** Sessions get no bus: an address nothing answers on, which each harness reports and goes on without. */
const noBus = Layer.succeed(BusEndpoint, {
  serverName: "cerium",
  register: () => Effect.succeed({ type: "http" as const, url: "http://127.0.0.1:9/mcp" }),
  unregister: () => Effect.void,
});

const layer = Orchestrator.layer.pipe(
  Layer.provideMerge(UserSettings.layer),
  Layer.provideMerge(
    Store.layer({
      filename: join(data, "cerium.db"),
      migrationsFolder: join(import.meta.dirname, "../../../../packages/store/migrations"),
    }),
  ),
  Layer.provideMerge(AdaptersLive),
  Layer.provide(Catalog.fromEntries([])),
  Layer.provide(noBus),
  Layer.provide(Worktrees.unavailable),
  Layer.provide(Checkpoints.unavailable),
  Layer.provide(ProjectScripts.unavailable),
  Layer.provide(OrchestratorConfig.layer({ chatDirectory: join(data, "chats") })),
  Layer.provide(NodeServices.layer),
);

interface Step {
  readonly name: string;
  readonly passed: boolean;
  readonly seconds: number;
  readonly detail: string;
}

const program = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  const adapters = yield* Adapters;
  const seen: Array<AgentEvent> = [];
  yield* orchestrator.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
    Effect.forkScoped,
  );

  const modelOf = Effect.fn("modelOf")(function* (provider: ProviderId) {
    const own = picked[provider];
    if (own !== undefined) return own;
    const adapter = adapters.get(provider);
    if (adapter === undefined) return yield* Effect.fail(`No ${provider} adapter is installed.`);
    const models = yield* adapter.listModels.pipe(Effect.mapError((error) => error.message));
    const model =
      models.find((each) => quick[provider]?.test(each.id)) ??
      models.find((each) => each.isDefault) ??
      models[0];
    if (model === undefined) return yield* Effect.fail(`${provider} offers no models.`);
    return model.id;
  });

  /** Sends a message and waits for the turn it starts to end; resolves with the lead's reply. */
  const ask = (lead: AgentId, text: string) =>
    Effect.gen(function* () {
      const ended = seen.filter(
        (event) => event.agentId === lead && event.payload._tag === "TurnCompleted",
      ).length;
      yield* orchestrator.sendUserMessage(lead, text);
      for (;;) {
        const done = seen.filter((event) => event.agentId === lead && event.payload._tag === "TurnCompleted");
        if (done.length > ended) break;
        yield* Effect.sleep("250 millis");
      }
      const reply = seen.findLast(
        (event) => event.agentId === lead && event.payload._tag === "MessageCompleted",
      );
      return reply?.payload._tag === "MessageCompleted" ? reply.payload.text : "";
    }).pipe(
      Effect.timeoutOrElse({
        duration: turnTimeout,
        orElse: () => Effect.fail(`No reply within ${Duration.toSeconds(turnTimeout)} seconds.`),
      }),
    );

  const steps: Array<Step> = [];
  const step = <A>(name: string, run: Effect.Effect<A, unknown>, check: (value: A) => string | undefined) =>
    Effect.gen(function* () {
      const started = Date.now();
      const outcome = yield* Effect.result(run);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const problem =
        outcome._tag === "Failure"
          ? typeof outcome.failure === "string"
            ? outcome.failure
            : String((outcome.failure as { message?: unknown }).message ?? outcome.failure)
          : check(outcome.success);
      const detail =
        outcome._tag === "Success" ? String(outcome.success).slice(0, 160).replace(/\s+/g, " ") : "";
      steps.push({ name, passed: problem === undefined, seconds, detail: problem ?? detail });
      return problem === undefined;
    });

  const fromModel = yield* modelOf(from);
  const toModel = yield* modelOf(to);
  const { lead } = yield* orchestrator.createThread({
    title: "Handoff check",
    mode: "work",
    cwd: mkdtempSync(join(data, "work-")),
    lead: { provider: from, model: fromModel, access: "auto" },
  });
  const says = (reply: string) =>
    reply.includes(CODE) ? undefined : `The reply doesn't name ${CODE}: ${reply}`;

  const ok =
    (yield* step(
      `${from}/${fromModel} hears the code word`,
      ask(lead.id, `Remember this code word for later: ${CODE}. Reply with just OK.`),
      () => undefined,
    )) &&
    (yield* step(
      `handed to ${to}/${toModel}`,
      orchestrator
        .handOffLead(lead.id, { provider: to, model: toModel })
        .pipe(Effect.map((info) => `${info.provider}/${info.model}`)),
      (now) => (now === `${to}/${toModel}` ? undefined : `The lead runs ${now}`),
    )) &&
    (yield* step(
      `${to} says the code word back`,
      ask(lead.id, "What code word did I give you earlier? Reply with just the code word."),
      says,
    )) &&
    (yield* step(
      `handed back to ${from}/${fromModel}`,
      orchestrator
        .handOffLead(lead.id, { provider: from, model: fromModel })
        .pipe(Effect.map((info) => `${info.provider}/${info.model}`)),
      (now) => (now === `${from}/${fromModel}` ? undefined : `The lead runs ${now}`),
    )) &&
    (yield* step(
      `${from} says it back again`,
      ask(lead.id, "Once more: which code word did I give you at the start? Reply with just the code word."),
      says,
    ));

  const events = yield* orchestrator.threadEvents(lead.threadId);
  const sessions = events.flatMap(({ payload }) =>
    payload._tag === "SessionStarted" ? [`${payload.provider}/${payload.model}`] : [],
  );
  const handoffs = events.filter(({ payload }) => payload._tag === "LeadHandedOff").length;
  if (ok) {
    steps.push({
      name: "the thread records both handoffs and a session on each harness",
      passed: handoffs === 2 && new Set(sessions.map((each) => each.split("/")[0])).size === 2,
      seconds: 0,
      detail: `${handoffs} handoffs; sessions: ${sessions.join(" → ")}`,
    });
  }
  return steps;
}).pipe(Effect.scoped, Effect.provide(layer));

const steps = await Effect.runPromise(program).catch((error: unknown) => [
  { name: "setup", passed: false, seconds: 0, detail: String(error) } satisfies Step,
]);
for (const each of steps) {
  console.log(`${each.passed ? "PASS" : "FAIL"}  ${each.name}  (${each.seconds}s)  ${each.detail}`);
}
const passed = steps.every((each) => each.passed) && steps.length >= 5;
console.log(passed ? "Handoff check passed." : "Handoff check failed.");
// Harness processes a stuck session left behind must not keep this one alive.
process.exit(passed ? 0 : 1);
