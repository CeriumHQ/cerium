import {
  HarnessFailure,
  type AdapterEvent,
  type AgentSession,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import { Clock, Deferred, Effect, Queue, Stream, type Cause } from "effect";

import { handleServerRequest, type RequestHandling } from "./approvals.ts";
import { accessPolicy, threadParams, toCodexEffort, type UserConfig } from "./config.ts";
import { listAllModels } from "./models.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";
import { connect, type AppServer, type RpcError } from "./rpc.ts";
import { CodexTranslator } from "./translate.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/**
 * A turn's input as Codex's own UI sends it: the text, which names skills as `$name`, then the
 * images by path and each skill whose file Codex reported.
 */
export const toUserInput = (text: string, extras: TurnExtras | undefined): Array<UserInput> => [
  { type: "text", text, text_elements: [] },
  ...(extras?.images ?? []).map((image): UserInput => ({ type: "localImage", path: image.path })),
  ...(extras?.skills ?? []).flatMap((skill): Array<UserInput> =>
    skill.path === undefined ? [] : [{ type: "skill", name: skill.name, path: skill.path }],
  ),
];

/** The parts of the user's effective Codex config a thread needs. Nothing else from it is kept. */
const readUserConfig = (server: AppServer, cwd: string) =>
  server.request("config/read", { cwd }).pipe(
    Effect.map(({ config }): UserConfig => {
      const servers = (config as { readonly mcp_servers?: Record<string, unknown> | null }).mcp_servers;
      const developerInstructions = config.developer_instructions;
      return {
        mcpServers: Object.keys(servers ?? {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      };
    }),
  );

/**
 * Starts (or resumes) a Codex thread on its own `codex app-server` process, so one session crashing
 * cannot take others with it. The session lives until the enclosing scope closes. `events` is
 * single-consumer.
 */
export const startCodexSession = Effect.fn("CodexAdapter.startSession")(function* (
  executablePath: string,
  options: SessionOptions,
) {
  const server = yield* connect(executablePath, options.cwd);
  const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  const emit = (payload: AdapterEvent["payload"], raw?: unknown) =>
    Queue.offer(events, raw === undefined ? { payload } : { payload, raw });
  const translator = new CodexTranslator();
  const policy = accessPolicy(options.access);

  const user = yield* readUserConfig(server, options.cwd).pipe(
    Effect.mapError(failure("Could not read the Codex config")),
  );
  // Efforts are clamped per model, so the catalog is read once up front.
  const catalog = yield* listAllModels(server, true).pipe(
    Effect.mapError(failure("Could not list Codex models")),
  );
  const efforts = new Map(
    catalog.map((model) => [
      model.model,
      model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    ]),
  );
  const effortFor = (model: string, effort: ReasoningEffort) => toCodexEffort(effort, efforts.get(model));

  const params = threadParams(
    options,
    user,
    options.effort === undefined ? undefined : effortFor(options.model, options.effort),
  );
  const response = yield* (
    options.resume === undefined
      ? server.request("thread/start", params)
      : server.request("thread/resume", { threadId: options.resume, ...params })
  ).pipe(
    Effect.mapError(
      failure(
        options.resume === undefined ? "Could not start a Codex thread" : "Could not resume the Codex thread",
      ),
    ),
  );
  const threadId = response.thread.id;
  yield* Queue.offerAll(events, translator.started(response));

  // Turn state. Codex answers `turn/start` and announces `turn/started` in either order.
  let model = options.model;
  let nextModel: string | undefined;
  let nextEffort: ReasoningEffort | undefined;
  let activeTurn: string | undefined;
  let lastCompletedTurn: string | undefined;
  let starting = false;
  let interruptWanted = false;
  let closing = false;

  /** Approvals waiting for the user; `undefined` means Codex withdrew the request. */
  const pendingPermissions = new Map<string, Deferred.Deferred<PermissionDecision | undefined>>();
  const permissionIds = new Map<string, string>();
  // Prefixed so ids stay unique across the processes an agent's resumed sessions run in.
  const requestPrefix = (yield* Clock.currentTimeMillis).toString(36);

  const interruptTurn = (turnId: string) =>
    server.request("turn/interrupt", { threadId, turnId }).pipe(
      Effect.asVoid,
      // The turn may already have ended.
      Effect.catchTag("RpcError", () => Effect.void),
      Effect.mapError(failure("Could not interrupt the Codex turn")),
    );

  const turnStarted = (turnId: string) =>
    Effect.gen(function* () {
      if (turnId === lastCompletedTurn) return;
      activeTurn = turnId;
      starting = false;
      if (interruptWanted) {
        interruptWanted = false;
        yield* interruptTurn(turnId).pipe(Effect.ignore);
      }
    });

  const onNotification = (message: ServerNotification) =>
    Effect.gen(function* () {
      if (message.method === "turn/started" && message.params.threadId === threadId) {
        yield* turnStarted(message.params.turn.id);
      } else if (message.method === "turn/completed" && message.params.threadId === threadId) {
        lastCompletedTurn = message.params.turn.id;
        activeTurn = undefined;
        starting = false;
        interruptWanted = false;
      } else if (message.method === "serverRequest/resolved") {
        const requestId = permissionIds.get(String(message.params.requestId));
        const pending = requestId === undefined ? undefined : pendingPermissions.get(requestId);
        if (pending !== undefined) yield* Deferred.succeed(pending, undefined);
      }
      yield* Queue.offerAll(events, translator.translate(message));
    });

  const awaitDecision = (
    request: ServerRequest,
    requestId: string,
    ask: Extract<RequestHandling, { _tag: "Ask" }>,
    pending: Deferred.Deferred<PermissionDecision | undefined>,
  ) =>
    Deferred.await(pending).pipe(
      Effect.flatMap((decision) => {
        // Withdrawn by Codex (the turn was interrupted): nothing to answer.
        if (decision === undefined) {
          return emit({ _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" });
        }
        const result = ask.reply(decision);
        return server
          .respond(request.id, result)
          .pipe(
            Effect.andThen(
              emit(
                { _tag: "PermissionResolved", requestId, decision: decision.decision, scope: decision.scope },
                { id: request.id, result },
              ),
            ),
          );
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pendingPermissions.delete(requestId);
          permissionIds.delete(String(request.id));
        }),
      ),
    );

  const onRequest = (request: ServerRequest) =>
    Effect.gen(function* () {
      const handling = handleServerRequest(request, {
        cwd: options.cwd,
        approveWorkspaceEdits: policy.approveWorkspaceEdits,
        trustedMcpServers: new Set(options.trustedMcpServers ?? []),
        item: (itemId) => translator.item(itemId),
        runningMcpCall: (serverName) => translator.runningMcpCall(serverName),
      });
      switch (handling._tag) {
        case "Reply":
          return yield* server.respond(request.id, handling.result);
        case "Fail":
          return yield* server.respondError(request.id, handling.code, handling.message);
        case "Ask": {
          const requestId = `${requestPrefix}-${request.id}`;
          const pending = yield* Deferred.make<PermissionDecision | undefined>();
          pendingPermissions.set(requestId, pending);
          permissionIds.set(String(request.id), requestId);
          yield* emit(
            {
              _tag: "PermissionRequested",
              requestId,
              toolName: handling.toolName,
              summary: handling.summary,
              input: handling.input,
            },
            request,
          );
          // Waiting for the user must not hold up the notifications behind this request.
          yield* awaitDecision(request, requestId, handling, pending).pipe(Effect.forkScoped);
          return;
        }
      }
    });

  yield* server.incoming.pipe(
    Stream.runForEach((incoming) =>
      incoming._tag === "Notification" ? onNotification(incoming.message) : onRequest(incoming.message),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        if (!closing) {
          yield* emit({
            _tag: "AgentError",
            kind: "crash",
            message: "The Codex app-server exited unexpectedly.",
            retryable: false,
          });
          if (starting || activeTurn !== undefined)
            yield* emit({ _tag: "TurnCompleted", stopReason: "error" });
        }
        yield* Queue.end(events);
      }),
    ),
    Effect.forkScoped,
  );
  // Registered last so it runs first: closing the scope is not a crash.
  yield* Effect.addFinalizer(() => Effect.sync(() => (closing = true)));

  /** A rejected `turn/start` still ends with one `TurnCompleted`, as the orchestrator expects. */
  const rejectedTurn = (error: RpcError) =>
    Effect.gen(function* () {
      starting = false;
      yield* emit(
        { _tag: "AgentError", kind: "unknown", message: error.message, retryable: false },
        error.response,
      );
      yield* emit({ _tag: "TurnCompleted", stopReason: "error" }, error.response);
    });

  const send = (text: string, extras?: TurnExtras) =>
    Effect.gen(function* () {
      const turnModel = nextModel ?? model;
      starting = true;
      const started = yield* server.request("turn/start", {
        threadId,
        input: toUserInput(text, extras),
        // Overrides apply to this turn and the ones after it.
        ...(nextModel === undefined ? {} : { model: nextModel }),
        ...(nextEffort === undefined ? {} : { effort: effortFor(turnModel, nextEffort) }),
      });
      model = turnModel;
      nextModel = undefined;
      nextEffort = undefined;
      yield* turnStarted(started.turn.id);
    }).pipe(
      Effect.catchTag("RpcError", rejectedTurn),
      Effect.mapError(failure("Could not start a Codex turn")),
    );

  return {
    events: Stream.fromQueue(events),
    send,
    respondToPermission: (requestId, decision) =>
      Effect.suspend(() => {
        const pending = pendingPermissions.get(requestId);
        return pending === undefined ? Effect.void : Deferred.succeed(pending, decision).pipe(Effect.asVoid);
      }),
    interrupt: Effect.suspend(() => {
      if (activeTurn !== undefined) return interruptTurn(activeTurn);
      if (starting) interruptWanted = true;
      return Effect.void;
    }),
    setModel: (next) => Effect.sync(() => (nextModel = next)),
    setEffort: (effort) => Effect.sync(() => (nextEffort = effort)),
    // A turn of Codex's own, announced and ended like one `turn/start` begins.
    compact: Effect.gen(function* () {
      starting = true;
      translator.compactAsked();
      yield* server.request("thread/compact/start", { threadId });
    }).pipe(
      Effect.catchTag("RpcError", rejectedTurn),
      Effect.mapError(failure("Could not compact the Codex thread")),
    ),
  } satisfies AgentSession;
});
