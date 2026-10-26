import {
  HarnessFailure,
  type AdapterEvent,
  type AgentSession,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import type { OpenCodeEvent } from "@opencode/client";
import { Cause, Deferred, Duration, Effect, Exit, Queue, Stream } from "effect";
import { basename, resolve } from "node:path";

import { call, openHost, type OpenCodeClient } from "./host.ts";
import { readCatalog, toModelRef, windowOf, type CatalogRow } from "./models.ts";
import { grantsFor, replyFor, sessionRules, toMcpServer, toolNamer, type Rule } from "./policy.ts";
import { CERIUM_METADATA } from "./sessions.ts";
import { OpenCodeTranslator, type OpenCodeRecord } from "./translate.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

/** The key of Cerium's instructions among the session's; OpenCode wraps them in `<context key="cerium">`. */
const INSTRUCTIONS_KEY = "cerium";
/** How long the event stream may take to connect. */
const CONNECT = Duration.seconds(15);
/** How long closing waits for an open turn to stop. */
const STOP_GRACE = Duration.seconds(5);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The session an event belongs to, for the server's events that name one. */
const sessionOf = (event: OpenCodeEvent): string | undefined => {
  const data: unknown = event.data;
  return isRecord(data) && typeof data["sessionID"] === "string" ? data["sessionID"] : undefined;
};

const TURN_ENDS = new Set<OpenCodeEvent["type"]>([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** The servers the user configured in OpenCode itself, which a session without them leaves out. */
const userServers = (client: OpenCodeClient, directory: string, injected: ReadonlyArray<string>) =>
  call("list its MCP servers", (signal) => client.mcp.list({ location: { directory } }, { signal })).pipe(
    Effect.map((servers) =>
      servers.data.map((server) => server.name).filter((name) => !injected.includes(name)),
    ),
  );

/** A message to send, or a compaction to ask for. */
type Turn = { readonly text: string; readonly extras?: TurnExtras } | { readonly compact: true };

/**
 * Starts (or resumes) an OpenCode session on a private `opencode serve`. Cerium's MCP servers join
 * the user's configuration for this server only, and the access mode becomes the session's permission
 * rules. Turns run one at a time in `send` order, each ending in exactly one `TurnCompleted`. The
 * session lives until the enclosing scope closes. `events` is single-consumer.
 */
export const startOpenCodeSession = Effect.fn("OpenCodeAdapter.startSession")(function* (
  executablePath: string,
  options: SessionOptions,
) {
  const cwd = resolve(options.cwd);
  const injected = Object.keys(options.mcpServers);
  const host = yield* openHost(executablePath, {
    cwd,
    config: {
      mcp: {
        servers: Object.fromEntries(
          Object.entries(options.mcpServers).map(([name, spec]) => [name, toMcpServer(spec)]),
        ),
      },
    },
  });
  const { client } = host;

  const events = yield* Queue.unbounded<AdapterEvent, HarnessFailure | Cause.Done>();
  const translator = new OpenCodeTranslator({
    toolName: toolNamer(injected),
    // Read as each step ends, after the catalog and model below are set.
    window: () => windowOf(model, catalog),
  });
  const emit = (record: OpenCodeRecord) => Queue.offerAllUnsafe(events, translator.translate(record));

  let sessionId: string | undefined;
  /** Resolves when the turn in flight has ended. */
  let turnEnded: Deferred.Deferred<void> | undefined;
  let closing = false;

  // The server's events, from before the session exists: its first turn's are never missed. Closing
  // the scope interrupts the stream, which ends the subscription.
  const connected = yield* Deferred.make<void>();
  const onEvent = (event: OpenCodeEvent) =>
    Effect.gen(function* () {
      if (event.type === "server.connected") return yield* Deferred.succeed(connected, undefined);
      if (sessionId === undefined || sessionOf(event) !== sessionId) return;
      emit({ type: "event", event });
      if (TURN_ENDS.has(event.type) && turnEnded !== undefined) yield* Deferred.succeed(turnEnded, undefined);
    });
  const lost = (message: string) => (cause: unknown) => {
    if (closing) return Effect.void;
    const reason = host.stderr();
    return Queue.fail(events, failure(reason ? `${message}: ${reason}` : message)(cause));
  };
  yield* Stream.fromAsyncIterable(client.event.subscribe(), (cause) => cause).pipe(
    Stream.runForEach(onEvent),
    Effect.matchEffect({
      onFailure: lost("OpenCode's event stream failed"),
      onSuccess: lost("OpenCode stopped"),
    }),
    Effect.forkScoped,
  );
  yield* Deferred.await(connected).pipe(
    Effect.timeoutOrElse({
      duration: CONNECT,
      orElse: () => Effect.fail(failure("OpenCode's event stream did not connect")(host.stderr())),
    }),
  );

  const { rows } = yield* readCatalog(client, cwd);
  let catalog: ReadonlyArray<CatalogRow> = rows;
  let model = options.model;
  let effort: ReasoningEffort | undefined = options.effort;
  let speed: ModelSpeed | undefined = options.speed;
  const selection = () => {
    const ref = toModelRef(model, effort, catalog, speed);
    return ref === undefined
      ? Effect.fail(failure(`"${model}" is not an OpenCode model; models are named provider/model`)(model))
      : Effect.succeed(ref);
  };

  const excluded = options.includeUserMcpServers ? [] : yield* userServers(client, cwd, injected);
  // Removing a server only drops it from this private server; the user's configuration is untouched.
  yield* Effect.forEach(
    excluded,
    (server) =>
      call("leave out an MCP server", (signal) =>
        client.mcp.remove({ server, location: { directory: cwd } }, { signal }),
      ).pipe(Effect.ignore),
    { discard: true },
  );
  let rules: ReadonlyArray<Rule> = sessionRules(options.access, options.trustedMcpServers ?? [], excluded);

  const ref = yield* selection();
  const resume = options.resume;
  const id =
    resume === undefined
      ? (yield* call("start a session", (signal) =>
          client.session.create(
            // Marked as Cerium's, so listing the user's own sessions leaves it out.
            {
              location: { directory: cwd },
              model: ref,
              permissions: rules,
              metadata: { ...CERIUM_METADATA },
            },
            { signal },
          ),
        )).id
      : (yield* call("resume the session", (signal) => client.session.get({ sessionID: resume }, { signal })))
          .id;
  if (resume !== undefined) {
    // A resumed session takes this run's access and model, which may differ from its last run's.
    yield* call("apply the session's access", (signal) =>
      client.session.update({ sessionID: id, permissions: rules }, { signal }),
    );
    yield* call("switch the session's model", (signal) =>
      client.session.switchModel({ sessionID: id, model: ref }, { signal }),
    );
  }
  sessionId = id;

  if (options.appendSystemPrompt !== undefined) {
    const value = options.appendSystemPrompt;
    yield* call("add Cerium's instructions", (signal) =>
      client.session.instructions.entry.put({ sessionID: id, key: INSTRUCTIONS_KEY, value }, { signal }),
    );
  }

  /** Sends not yet answered by their `TurnCompleted`, including ones waiting to start. */
  let pending = 0;
  /** An interrupt that arrived before the turn's prompt was sent; the turn ends without it. */
  let interruptRequested = false;

  const interruptTurn = call("interrupt the turn", (signal) =>
    client.session.interrupt({ sessionID: id }, { signal }),
  ).pipe(Effect.asVoid);

  // An interrupted turn is never resumed by OpenCode's own service, which shares the user's sessions.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      if (turnEnded !== undefined && !Deferred.isDoneUnsafe(turnEnded)) {
        yield* interruptTurn.pipe(
          Effect.andThen(Deferred.await(turnEnded)),
          Effect.timeout(STOP_GRACE),
          Effect.ignore,
        );
      }
      yield* Queue.end(events);
    }),
  );
  emit({ type: "opened", sessionId: id, model, effort });

  const skillIds = (skills: TurnExtras["skills"]) =>
    skills === undefined || skills.length === 0
      ? Effect.succeed([])
      : call("list its skills", (signal) =>
          client.skill.list({ location: { directory: cwd } }, { signal }),
        ).pipe(
          Effect.map((listed) =>
            skills.flatMap((skill) => {
              const found = listed.data.find(
                (entry) =>
                  entry.name === skill.name || (skill.path !== undefined && entry.path === skill.path),
              );
              return found === undefined ? [] : [{ id: found.id }];
            }),
          ),
          // The text still names each skill as `$name`, which the model can follow without them.
          Effect.orElseSucceed(() => []),
        );

  const prompt = ({ text, extras }: { readonly text: string; readonly extras?: TurnExtras }) =>
    Effect.gen(function* () {
      const files = (extras?.images ?? []).map((image) => ({
        uri: `data:${image.mediaType};base64,${image.data}`,
        name: basename(image.path),
      }));
      const skills = yield* skillIds(extras?.skills);
      return yield* call("send the message", (signal) =>
        client.session.prompt(
          {
            sessionID: id,
            text,
            ...(files.length > 0 ? { files } : {}),
            ...(skills.length > 0 ? { skills } : {}),
          },
          { signal },
        ),
      );
    });

  const runTurn = (turn: Turn) =>
    Effect.gen(function* () {
      if (interruptRequested) {
        interruptRequested = false;
        pending--;
        emit({ type: "promptSkipped" });
        return;
      }
      const ended = yield* Deferred.make<void>();
      turnEnded = ended;
      const send: Effect.Effect<void, HarnessFailure> =
        "compact" in turn
          ? Effect.asVoid(
              call("compact the session", (signal) => client.session.compact({ sessionID: id }, { signal })),
            )
          : Effect.asVoid(prompt(turn));
      const sent = yield* Effect.exit(send);
      if (Exit.isFailure(sent)) {
        const error = Cause.squash(sent.cause);
        emit({ type: "promptFailed", message: error instanceof Error ? error.message : String(error) });
      } else {
        if (interruptRequested) yield* interruptTurn.pipe(Effect.ignore);
        // A server that exits mid-turn ends the turn; its stream then fails the session.
        yield* Effect.raceFirst(Deferred.await(ended), host.exited);
      }
      turnEnded = undefined;
      interruptRequested = false;
      pending--;
    });

  const input = yield* Queue.unbounded<Turn>();
  yield* Effect.forkScoped(Effect.forever(Queue.take(input).pipe(Effect.flatMap(runTurn))));

  const switchModel = (next: {
    readonly model?: string;
    readonly effort?: ReasoningEffort;
    readonly speed?: ModelSpeed;
  }) =>
    Effect.gen(function* () {
      if (next.model !== undefined && !catalog.some((row) => `${row.providerID}/${row.id}` === next.model)) {
        catalog = (yield* readCatalog(client, cwd)).rows;
      }
      const previous = { model, effort, speed };
      model = next.model ?? model;
      effort = next.effort ?? effort;
      speed = next.speed ?? speed;
      const ref = yield* selection();
      yield* call("switch the session's model", (signal) =>
        client.session.switchModel({ sessionID: id, model: ref }, { signal }),
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            model = previous.model;
            effort = previous.effort;
            speed = previous.speed;
          }),
        ),
      );
    });

  const respondToPermission = (requestId: string, decision: PermissionDecision) =>
    Effect.gen(function* () {
      const ask = translator.ask(requestId);
      if (ask === undefined) return;
      // Resolved first, so the server's own `permission.replied` finds nothing left to close.
      Queue.offerAllUnsafe(
        events,
        translator.resolved(requestId, { decision: decision.decision, scope: decision.scope }, decision),
      );
      if (decision.decision === "allow" && decision.scope === "session") {
        const granted = [...rules, ...grantsFor(ask)];
        yield* call("allow it for the session", (signal) =>
          client.session.update({ sessionID: id, permissions: granted }, { signal }),
        ).pipe(
          Effect.tap(() => Effect.sync(() => (rules = granted))),
          Effect.ignore,
        );
      }
      yield* call("answer the permission request", (signal) =>
        client.permission.reply({ sessionID: id, requestID: requestId, ...replyFor(decision) }, { signal }),
      ).pipe(Effect.ignore);
    });

  return {
    events: Stream.fromQueue(events),
    send: (text, extras) =>
      Effect.sync(() => pending++).pipe(
        Effect.andThen(Queue.offer(input, { text, ...(extras ? { extras } : {}) })),
        Effect.asVoid,
      ),
    respondToPermission,
    // A prompt still on its way may start its execution after the interrupt; it is interrupted again then.
    interrupt: Effect.suspend(() => {
      if (pending > 0) interruptRequested = true;
      return turnEnded === undefined ? Effect.void : interruptTurn;
    }),
    // Each applies from the next step; a running step finishes on the model it started with.
    setModel: (next) => switchModel({ model: next }),
    setEffort: (next) => switchModel({ effort: next }),
    setSpeed: (next) => switchModel({ speed: next }),
    // Queued like a message: OpenCode runs the compaction as an execution of its own.
    compact: Effect.sync(() => pending++).pipe(
      Effect.andThen(Queue.offer(input, { compact: true })),
      Effect.asVoid,
    ),
  } satisfies AgentSession;
});
