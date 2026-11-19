import {
  type AdapterEvent,
  type AgentSession,
  type CompletionUsage,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { EventPayload, ModelInfo, ReasoningEffort } from "@cerium/protocol";
import { Cause, Deferred, Effect, Queue, Semaphore, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { classifyPermission, sessionPolicy } from "./policy.ts";
import { failure, record, string, type CopilotHost } from "./rpc.ts";
import { translateEvent, translateUsage } from "./translate.ts";

interface SessionSetup {
  readonly options: SessionOptions;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly completionInstructions?: string;
}

interface Turn {
  interrupted: boolean;
  failed: boolean;
  usage?: CompletionUsage;
}

interface PendingPermission {
  readonly operation: Record<string, unknown> | undefined;
  decision?: PermissionDecision;
}

export const startCopilotSession = Effect.fn("CopilotAdapter.startCopilotSession")(function* (
  host: CopilotHost,
  { options, models, completionInstructions }: SessionSetup,
) {
  const ephemeral = completionInstructions !== undefined;
  const sessionId = options.resume ?? randomUUID();
  const inbox = yield* Queue.unbounded<Record<string, unknown>>();
  const events = yield* Queue.unbounded<AdapterEvent, ReturnType<ReturnType<typeof failure>> | Cause.Done>();
  const serial = yield* Semaphore.make(1);
  const connected = yield* Deferred.make<void>();
  const pending = new Map<string, PendingPermission>();
  const grants: Array<Record<string, unknown>> = [];
  let closing = false;
  let active: Turn | undefined;
  let model = options.model;
  const initialModel = models.find(({ id }) => id === model);
  let effort = options.effort;
  if (effort !== undefined && initialModel && !initialModel.efforts.includes(effort)) effort = undefined;

  const request = (method: string, params: Record<string, unknown> = {}) =>
    host.request(method, { ...params, sessionId });
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
      case "session.idle": {
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
            stopReason:
              interrupted || data["aborted"] === true ? "interrupted" : failed ? "error" : "completed",
          },
          event,
        );
        return;
      }
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
    }
    if (!active && event["type"] !== "session.usage_info") return;
    for (const payload of translateEvent(event, data)) emit(payload, event);
  });

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
      yield* request(ephemeral ? "session.delete" : "session.detach").pipe(
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
    model,
    inference: { reasoningEffort: effort },
    permissions: { request: true, mode: "manual" },
    hooks: { enableRepositoryHooks: false },
    filesystem: { trackFileChanges: !ephemeral },
    github: { telemetryEnabled: false, fetchManagedSettings: true },
    events: { streaming: !ephemeral, includeSubAgentStreamingEvents: false },
    extensions: { enabled: false },
    state: { memory: { enabled: false }, enableCrossSessionStore: false },
    instructions: { directories: ephemeral ? [] : [options.cwd] },
    ...(options.resume ? { continuePendingWork: false } : {}),
    ...(ephemeral
      ? {
          enableConfigDiscovery: false,
          tools: { availableTools: [] },
          skills: { enabled: false },
          git: { enableHostGitOperations: false },
          systemMessage: { mode: "replace", content: completionInstructions },
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
        const turn = { interrupted: false, failed: false } satisfies Turn;
        active = turn;
        const attachments = extras?.images?.map(({ path, data, mediaType }) => ({
          type: "blob",
          data,
          mimeType: mediaType,
          displayName: basename(path),
        }));
        yield* request("session.send", {
          prompt,
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
