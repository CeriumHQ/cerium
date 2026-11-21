import {
  type AdapterEvent,
  type AgentSession,
  type CompletionUsage,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { BackgroundTask, EventPayload, ModelInfo, ReasoningEffort, TodoItem } from "@cerium/protocol";
import { Cause, Deferred, Effect, Queue, Semaphore, Stream, type Duration } from "effect";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { classifyPermission, readTools, sessionPolicy } from "./policy.ts";
import { failure, record, string, type CopilotHost } from "./rpc.ts";
import { expandCopilotSkills } from "./skills.ts";
import { translateEvent, translateTask, translateTodo, translateUsage } from "./translate.ts";

/** Cerium's client name, used to filter its own sessions from import. */
export const CLIENT_NAME = "Cerium";

/**
 * A session that answers once and is deleted when it closes: a completion, with no conversation, no
 * tools and only Cerium's instructions, or a side question, asked in a fork of a conversation with
 * Cerium's instructions after Copilot's and only the tools that read.
 */
export interface Answering {
  readonly instructions: string;
  readonly conversation: boolean;
}

interface SessionSetup {
  readonly options: SessionOptions;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly answering?: Answering;
}

interface Turn {
  interrupted: boolean;
  failed: boolean;
  /** A compaction Cerium asked for, which ends when `session.history.compact` answers. */
  compacting?: boolean;
  /** Copilot reported a compaction's outcome in `session.compaction_complete`. */
  compacted?: boolean;
  usage?: CompletionUsage;
}

/** Ends a compaction turn in the event order: after the compaction's own events. */
const COMPACTED = "cerium.compacted";

interface PendingPermission {
  readonly operation: Record<string, unknown> | undefined;
  decision?: PermissionDecision;
}

export const startCopilotSession = Effect.fn("CopilotAdapter.startCopilotSession")(function* (
  host: CopilotHost,
  { options, models, answering }: SessionSetup,
) {
  const ephemeral = answering !== undefined;
  const sessionId = options.resume ?? randomUUID();
  const inbox = yield* Queue.unbounded<Record<string, unknown>>();
  const events = yield* Queue.unbounded<AdapterEvent, ReturnType<ReturnType<typeof failure>> | Cause.Done>();
  const serial = yield* Semaphore.make(1);
  const connected = yield* Deferred.make<void>();
  const pending = new Map<string, PendingPermission>();
  const grants: Array<Record<string, unknown>> = [];
  let closing = false;
  let active: Turn | undefined;
  let todos: ReadonlyArray<TodoItem> = [];
  let tasks: ReadonlyArray<BackgroundTask> = [];
  let model = options.model;
  const initialModel = models.find(({ id }) => id === model);
  let effort = options.effort;
  if (effort !== undefined && initialModel && !initialModel.efforts.includes(effort)) effort = undefined;

  const request = (method: string, params: Record<string, unknown> = {}, timeout?: Duration.Input) =>
    host.request(method, { ...params, sessionId }, timeout);
  const scope = yield* Effect.scope;
  const emit = (payload: EventPayload, raw?: unknown) =>
    Queue.offerUnsafe(events, raw === undefined ? { payload } : { payload, raw });
  const failEvents = (error: ReturnType<ReturnType<typeof failure>>) =>
    closing ? Effect.void : Queue.fail(events, error).pipe(Effect.asVoid);

  const subscription = host.connection.onNotification("session.event", (message: unknown) => {
    const notification = record(message);
    const event = record(notification?.["event"]);
    if (!closing && notification?.["sessionId"] === sessionId && event) Queue.offerUnsafe(inbox, event);
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => subscription.dispose()));

  const finishPermission = (requestId: string, decision: "allow" | "deny") => {
    const permission = pending.get(requestId);
    if (!permission) return;
    pending.delete(requestId);
    const scope =
      decision === "allow" && permission.operation && permission.decision?.scope === "session"
        ? "session"
        : "once";
    if (scope === "session" && permission.operation) grants.push(permission.operation);
    emit({ _tag: "PermissionResolved", requestId, decision, scope });
  };

  const reply = (requestId: string, decision: PermissionDecision) =>
    request("session.permissions.handlePendingPermissionRequest", {
      requestId,
      result:
        decision.decision === "allow"
          ? { kind: "approve-once" }
          : { kind: "reject", ...(decision.message ? { feedback: decision.message } : {}) },
    });

  const gatePermission = Effect.fnUntraced(function* (data: Record<string, unknown>) {
    const requestId = string(data["requestId"]);
    if (!requestId || pending.has(requestId) || data["resolvedByHook"] === true) return;
    const permission = classifyPermission(options, data);
    const permittedBefore =
      permission.operation !== undefined &&
      grants.some((granted) => isDeepStrictEqual(granted, permission.operation));
    const decision =
      ephemeral || !active || active.interrupted
        ? "deny"
        : (permission.decision ?? (permittedBefore ? "allow" : undefined));
    if (decision !== undefined) {
      yield* reply(requestId, { decision, scope: "once" });
      return;
    }
    pending.set(requestId, { operation: permission.operation });
    emit({
      _tag: "PermissionRequested",
      requestId,
      toolName: permission.toolName,
      summary: permission.summary,
      input: permission.request,
    });
  });

  const onEvent = Effect.fnUntraced(function* (event: Record<string, unknown>) {
    if (event["agentId"] !== undefined) return;
    const data = record(event["data"]) ?? {};
    switch (event["type"]) {
      case "permission.requested":
        return yield* gatePermission(data);
      case "permission.completed": {
        const id = string(data["requestId"]);
        const kind = record(data["result"])?.["kind"];
        if (id && typeof kind === "string")
          finishPermission(id, kind.startsWith("approved") ? "allow" : "deny");
        return;
      }
      case "session.idle":
        return endTurn(data["aborted"] === true, event);
      case COMPACTED: {
        // `session.idle` may have ended it already.
        if (!active?.compacting) return;
        const outcome = record(data["result"]);
        if (outcome?.["success"] !== true) {
          active.failed = true;
          const reason = string(data["error"]);
          // A compaction that ran and failed has said so in its own event.
          if (!active.compacted) {
            emit({
              _tag: "AgentError",
              kind: "unknown",
              message: `GitHub Copilot couldn't compact the conversation${reason ? `: ${reason}` : ""}`,
              retryable: false,
            });
          }
        }
        return endTurn(false, event);
      }
      case "session.todos_changed":
        return yield* refreshTodos;
      case "session.background_tasks_changed":
        return yield* refreshTasks;
      case "assistant.usage": {
        const usage = translateUsage(data);
        if (!active || !usage) return;
        const before = active.usage;
        const cached = usage.cachedInputTokens ?? before?.cachedInputTokens;
        active.usage = {
          inputTokens: (before?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (before?.outputTokens ?? 0) + usage.outputTokens,
          ...(cached === undefined
            ? {}
            : { cachedInputTokens: (before?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0) }),
        };
        return;
      }
      case "session.error":
        if (active) active.failed = true;
        break;
      case "session.compaction_complete":
        if (active) active.compacted = true;
        break;
    }
    if (!active && event["type"] !== "session.usage_info") return;
    for (const payload of translateEvent(event, data)) emit(payload, event);
  });

  const endTurn = (aborted: boolean, event: Record<string, unknown>) => {
    if (!active) return;
    const { interrupted, failed, usage } = active;
    active = undefined;
    for (const id of pending.keys()) finishPermission(id, "deny");
    emit({
      _tag: "UsageReported",
      provider: "copilot",
      model,
      ...(usage ?? { inputTokens: 0, outputTokens: 0, unreported: true }),
    });
    emit(
      {
        _tag: "TurnCompleted",
        stopReason: interrupted || aborted ? "interrupted" : failed ? "error" : "completed",
      },
      event,
    );
  };

  /** The `todos_changed` and `background_tasks_changed` events carry nothing: Cerium reads the state. */
  const refreshTodos = request("session.plan.readSqlTodos").pipe(
    Effect.map((result) => {
      const rows = record(result)?.["rows"];
      const next = Array.isArray(rows) ? rows.flatMap(translateTodo) : [];
      if (isDeepStrictEqual(next, todos)) return;
      todos = next;
      emit({ _tag: "TodosUpdated", items: next }, result);
    }),
    // A state Cerium couldn't read leaves the last one shown; the session goes on.
    Effect.catch((error) => Effect.logDebug("Could not read GitHub Copilot's todos", error)),
  );
  const refreshTasks = request("session.tasks.list").pipe(
    Effect.map((result) => {
      const listed = record(result)?.["tasks"];
      const next = Array.isArray(listed) ? listed.flatMap(translateTask) : [];
      if (isDeepStrictEqual(next, tasks)) return;
      tasks = next;
      emit({ _tag: "BackgroundTasksChanged", tasks: next }, result);
    }),
    Effect.catch((error) => Effect.logDebug("Could not read GitHub Copilot's background tasks", error)),
  );

  yield* Deferred.await(connected).pipe(
    Effect.andThen(Stream.fromQueue(inbox).pipe(Stream.runForEach(onEvent))),
    Effect.catch(failEvents),
    Effect.forkScoped,
  );
  yield* Effect.promise(() => host.exited).pipe(
    Effect.andThen(
      Effect.suspend(() => failEvents(failure("GitHub Copilot CLI exited unexpectedly")(undefined))),
    ),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closing = true;
      if (active) {
        yield* request("session.abort").pipe(Effect.timeout("2 seconds"), Effect.ignore);
      }
      yield* request(answering?.conversation === false ? "session.delete" : "session.detach").pipe(
        Effect.timeout("3 seconds"),
        Effect.ignore,
      );
      yield* Queue.end(events);
    }),
  );

  const { verifyMcp, ...policy } = yield* sessionPolicy(host, options);
  const setup = {
    ...policy,
    workingDirectory: options.cwd,
    clientName: CLIENT_NAME,
    model,
    inference: { reasoningEffort: effort },
    permissions: { request: true, mode: "manual" },
    hooks: { enableRepositoryHooks: false },
    filesystem: { trackFileChanges: !ephemeral },
    github: { telemetryEnabled: false, fetchManagedSettings: true },
    events: { streaming: !ephemeral, includeSubAgentStreamingEvents: false },
    extensions: { enabled: false },
    state: { memory: { enabled: false }, enableCrossSessionStore: false },
    instructions: { directories: answering?.conversation === false ? [] : [options.cwd] },
    skills: { enabled: !ephemeral },
    ...(options.resume ? { continuePendingWork: false } : {}),
    ...(answering
      ? {
          enableConfigDiscovery: false,
          tools: { availableTools: answering.conversation ? readTools : [] },
          git: { enableHostGitOperations: false },
          systemMessage: {
            mode: answering.conversation ? "append" : "replace",
            content: answering.instructions,
          },
        }
      : options.appendSystemPrompt === undefined
        ? {}
        : { systemMessage: { mode: "append", content: options.appendSystemPrompt } }),
  };
  const opened = record(yield* request(options.resume ? "session.resume" : "session.create", setup));
  if (opened?.["sessionId"] !== sessionId || opened["isRemote"] === true) {
    return yield* failure("GitHub Copilot CLI did not open the requested local session")(undefined);
  }
  yield* verifyMcp(sessionId);
  const mode = record(yield* request("session.permissions.getMode"));
  if (mode?.["mode"] !== "manual") {
    return yield* failure("GitHub Copilot CLI could not use manual permission handling")(undefined);
  }
  const permissions = record(
    yield* request("session.permissions.configure", {
      approveAllToolPermissionRequests: false,
      approveAllReadPermissionRequests: false,
      paths: { unrestricted: false, includeTempDirectory: false },
      urls: { unrestricted: false },
    }),
  );
  if (permissions?.["success"] !== true) {
    return yield* failure("GitHub Copilot CLI could not apply the session's permission policy")(undefined);
  }

  emit({
    _tag: "SessionStarted",
    provider: "copilot",
    providerSessionId: sessionId,
    model,
    ...(effort === undefined ? {} : { effort }),
  });
  yield* Deferred.succeed(connected, undefined);

  const send = (prompt: string, extras?: TurnExtras) =>
    serial.withPermit(
      Effect.gen(function* () {
        if (active) return yield* failure("GitHub Copilot is already processing a turn")(undefined);
        const skills = yield* expandCopilotSkills(host, sessionId, extras?.skills).pipe(
          Effect.orElseSucceed(() => []),
        );
        const turn = { interrupted: false, failed: false } satisfies Turn;
        active = turn;
        const attachments = extras?.images?.map(({ path, data, mediaType }) => ({
          type: "blob",
          data,
          mimeType: mediaType,
          displayName: basename(path),
        }));
        yield* request("session.send", {
          prompt: skills.length === 0 ? prompt : [...skills, prompt].join("\n\n"),
          ...(skills.length === 0 ? {} : { displayPrompt: prompt }),
          agentMode: "interactive",
          ...(extras?.turnId === undefined ? {} : { clientTurnId: extras.turnId }),
          ...(attachments?.length ? { attachments } : {}),
        }).pipe(
          Effect.catch((error) => {
            if (active !== turn) return Effect.void;
            active = undefined;
            for (const id of pending.keys()) finishPermission(id, "deny");
            // An RPC failure can happen after dispatch. Stop any work before the session takes
            // another turn. The caller publishes the terminal event when send returns an error.
            return request("session.abort").pipe(
              Effect.timeout("2 seconds"),
              Effect.ignore,
              Effect.andThen(Effect.fail(error)),
            );
          }),
        );
      }),
    );

  const switchModel = (nextModel: string, nextEffort: ReasoningEffort | undefined) =>
    Effect.gen(function* () {
      if (active)
        return yield* failure("GitHub Copilot can switch models and effort between turns")(undefined);
      const result = record(
        yield* request("session.model.switchTo", {
          modelId: nextModel,
          reasoningEffort: nextEffort ?? null,
          requireAvailable: true,
        }),
      );
      if (
        result?.["modelId"] !== nextModel ||
        result["deferred"] === true ||
        ["cancelled", "confirmation_required", "failed", "rejected"].includes(String(result["status"]))
      ) {
        return yield* failure("GitHub Copilot CLI could not switch to the requested model and effort")(
          undefined,
        );
      }
      model = nextModel;
      effort = nextEffort;
    });

  return {
    events: Stream.fromQueue(events),
    send,
    interrupt: Effect.gen(function* () {
      if (!active) return;
      active.interrupted = true;
      yield* request("session.abort");
    }),
    setModel: (next) =>
      serial.withPermit(
        Effect.suspend(() => {
          const available = models.find(({ id }) => id === next)?.efforts ?? [];
          return next === model
            ? Effect.void
            : switchModel(next, effort && available.includes(effort) ? effort : undefined);
        }),
      ),
    setEffort: (next) =>
      serial.withPermit(Effect.suspend(() => (next === effort ? Effect.void : switchModel(model, next)))),
    // A turn of its own: Copilot reports the compaction in `session.compaction_complete`, and the turn
    // ends once `session.history.compact` answers, queued behind that event.
    compact: serial.withPermit(
      Effect.gen(function* () {
        if (active) return yield* failure("GitHub Copilot can compact between turns")(undefined);
        active = { interrupted: false, failed: false, compacting: true };
        const ended = (data: Record<string, unknown>) => Queue.offerUnsafe(inbox, { type: COMPACTED, data });
        // A long conversation takes a while to summarize.
        yield* request("session.history.compact", { trigger: "manual" }, "10 minutes").pipe(
          Effect.match({
            onSuccess: (result) => ended({ result }),
            onFailure: (error) => ended({ error: error.message }),
          }),
          Effect.forkIn(scope),
        );
      }),
    ),
    stopBackgroundTask: (taskId) =>
      request("session.tasks.cancel", { id: taskId }).pipe(
        Effect.flatMap((result) =>
          record(result)?.["cancelled"] === false
            ? Effect.fail(failure("GitHub Copilot CLI could not stop the background task")(result))
            : Effect.void,
        ),
      ),
    respondToPermission: (id, decision) =>
      Effect.gen(function* () {
        const permission = pending.get(id);
        if (!permission || permission.decision || closing || !active || active.interrupted) return;
        permission.decision = decision;
        const result = record(
          yield* reply(id, decision).pipe(
            Effect.catch((error) => failEvents(error).pipe(Effect.as(undefined))),
          ),
        );
        if (result?.["success"] === true) finishPermission(id, decision.decision);
        else if (pending.has(id)) finishPermission(id, "deny");
      }),
  } satisfies AgentSession;
});
