import {
  HarnessFailure,
  HarnessUnavailable,
  type AdapterEvent,
  type AgentSession,
  type PermissionDecision,
  type SessionOptions,
  type TurnExtras,
} from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import {
  MspError,
  readSessionDurability,
  Session,
  type ApprovalDecisionInput,
  type ExitClassification,
  type SessionOpening,
} from "@muse-code/sdk";
import type {
  ApprovalRequestParams,
  ApprovalResolvedParams,
  Notification,
  SessionResumeResult,
  SessionStartResult,
  TurnInputPart,
} from "@muse-code/sdk/dist/src/msp.js";
import { Cause, Data, Deferred, Effect, Queue, Schema, Stream } from "effect";

import { openHost, type MuseHost } from "./host.ts";
import { SDK_RELEASE } from "./manifest.ts";
import { ModelList } from "./models.ts";
import {
  accessPolicy,
  approvalSummary,
  choiceOutcome,
  decisionOutcome,
  fingerprintVerdict,
  isTrustedTool,
  pickApprovalChoice,
  serveArgs,
  toMuseEffort,
  toSessionMcp,
} from "./policy.ts";
import { MuseTranslator, type WireNotification } from "./translate.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "muse", message, cause });

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Muse Code refused an MSP call; `cause` is usually the SDK's `MspError`. */
class MuseCallError extends Data.TaggedError("MuseCallError")<{ readonly cause: unknown }> {}

/** Whether Muse answered with a protocol error (as opposed to the transport failing). */
const refusedByMuse = (error: MuseCallError) => error.cause instanceof MspError;

/** What the fixture recorder sees: this session's frames, and the turns Cerium submits, in order. */
export type RecordedFrame =
  | WireNotification
  | { readonly cerium: "expectTurn"; readonly turnId: string }
  | { readonly cerium: "renameTurn"; readonly from: string; readonly to: string };

/**
 * A turn's parts: the text, then each image as base64. Skills stay in the text as `$name`: a `skill`
 * part with a selector Muse doesn't know fails the whole turn.
 */
export const toTurnInput = (text: string, extras: TurnExtras | undefined): Array<TurnInputPart> => [
  { type: "text", text },
  ...(extras?.images ?? []).map((image): TurnInputPart => ({
    type: "image",
    base64Data: image.data,
    mediaType: image.mediaType,
  })),
];

/** How a session's host differs from an agent's: for completions, the offline checks and the fixture recorder. */
export interface MuseHostOverrides {
  /** `echo` answers every turn without an account, so the whole protocol runs offline. */
  readonly provider?: "echo";
  readonly record?: (frame: RecordedFrame) => void;
  /** Nothing is saved: the host keeps its sessions in memory (completions). */
  readonly ephemeral?: boolean;
}

type Verdict =
  | { readonly by: "cerium"; readonly decision: PermissionDecision }
  | { readonly by: "elsewhere"; readonly outcome: Pick<PermissionDecision, "decision" | "scope"> };

const exitSummary = (exit: ExitClassification) =>
  exit.kind === "cleanShutdown"
    ? "clean shutdown"
    : [
        exit.kind,
        "exitCode" in exit && exit.exitCode !== null ? `exit ${exit.exitCode}` : undefined,
        exit.stderrTail.at(-1),
      ]
        .filter(Boolean)
        .join(", ");

/**
 * Starts a Muse Code session on its own `muse serve` host. Sandbox posture and the `-c` settings are fixed
 * per host process, and access modes and system prompts differ per agent, so every session gets a host;
 * closing the enclosing scope ends both. `events` is single-consumer.
 */
export const startMuseSession = Effect.fn("MuseAdapter.startSession")(function* (
  executablePath: string,
  options: SessionOptions,
  overrides: MuseHostOverrides = {},
) {
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);

  const events = yield* Queue.unbounded<AdapterEvent, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.end(events));
  const emit = (batch: ReadonlyArray<AdapterEvent>) => {
    for (const event of batch) Queue.offerUnsafe(events, event);
  };

  const policy = accessPolicy(options.access);
  const host: MuseHost = yield* openHost(
    executablePath,
    serveArgs({
      access: options.access,
      appendSystemPrompt: options.appendSystemPrompt,
      provider: overrides.provider,
      ephemeral: overrides.ephemeral,
    }),
    { cwd: options.cwd, capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false } },
  );
  const { connection } = host;
  const handshake = host.spawned.initializeResult;

  // Pin the schema: the SDK's types describe the stable surface it was built for (FR-006).
  const verdict = fingerprintVerdict(handshake.schema.fingerprint, handshake.serverInfo.version);
  if (verdict === "incompatible") {
    return yield* new HarnessUnavailable({
      provider: "muse",
      reason: "versionTooOld",
      message:
        `Muse Code ${handshake.serverInfo.version} serves an MSP schema that @muse-code/sdk ${SDK_RELEASE} was not` +
        ` built for (${handshake.schema.fingerprint}). Update Muse Code to ${SDK_RELEASE} or newer by running \`muse\`.`,
    });
  }
  if (verdict === "additive") {
    yield* Effect.logDebug(
      `Muse Code ${handshake.serverInfo.version} serves a newer MSP schema than the SDK pins; stable MSP evolves additively.`,
    );
  }

  const injected = Object.entries(options.mcpServers);
  if (injected.length > 0 && !handshake.grantedCapabilities.includes("sessionMcp")) {
    return yield* new HarnessFailure({
      provider: "muse",
      message: "Muse Code did not grant per-session MCP servers, so Cerium's tools cannot be injected",
      cause: handshake.grantedCapabilities,
    });
  }

  const translator = new MuseTranslator({ workspace: options.cwd, resumed: options.resume !== undefined });
  const trusted = options.trustedMcpServers ?? [];
  const pendingApprovals = new Map<
    string,
    { readonly approvalId: string; readonly verdict: Deferred.Deferred<Verdict> }
  >();
  /** Approvals another party resolved while Cerium was asking; their abandoned round trips are expected. */
  const abandoned = new Set<string>();
  let session: Session | undefined;
  let closing = false;
  const opening: Array<Notification> = [];

  const apply = (target: Session, notification: Notification) => {
    try {
      target.apply(notification);
    } catch (error) {
      void run(Effect.logWarning("The Muse session fold refused a frame", notification.method, error));
    }
  };

  const resolvedElsewhere = (params: ApprovalResolvedParams) => {
    for (const pending of pendingApprovals.values()) {
      if (pending.approvalId !== params.approvalId) continue;
      abandoned.add(params.approvalId);
      Deferred.doneUnsafe(
        pending.verdict,
        Effect.succeed({ by: "elsewhere", outcome: decisionOutcome(params.decision) }),
      );
    }
  };

  // The one inbound pump. Frames that arrive while the session opens (a resume's replay) only seed the
  // SDK's fold; afterwards each frame for this session is translated, then folded.
  connection.onNotification((notification) => {
    if (session === undefined) {
      opening.push(notification);
      return;
    }
    if (notification.params?.["sessionId"] !== session.sessionId) return;
    overrides.record?.(notification);
    if (notification.method === "approval/resolved") {
      resolvedElsewhere(notification.params as unknown as ApprovalResolvedParams);
    }
    emit(translator.translate(notification));
    apply(session, notification);
  });

  const command = (method: string, params: Record<string, unknown>, commandId?: string) =>
    Effect.tryPromise({
      try: () => connection.command(method, params, commandId ? { commandId } : undefined),
      catch: (cause) => new MuseCallError({ cause }),
    });

  // Open the session.
  const mcpServers = Object.fromEntries(injected.map(([name, spec]) => [name, toSessionMcp(spec)]));
  const config = injected.length > 0 ? { config: { mcpServers } } : {};
  const verb = options.resume ? "session/resume" : "session/start";
  const result = yield* command(
    verb,
    options.resume
      ? {
          sessionId: options.resume,
          excludeItems: true,
          permissionProfile: policy.permissionProfile,
          ...config,
        }
      : {
          workspaceRoot: options.cwd,
          ...(overrides.provider === "echo" ? {} : { modelId: options.model }),
          approvalMode: policy.approvalMode,
          // A memory-only host has one fixed profile and refuses any other; its serve flags set access.
          ...(overrides.ephemeral ? {} : { permissionProfile: policy.permissionProfile }),
          ...config,
        },
  ).pipe(Effect.mapError(failure(`Muse Code refused \`${verb}\``)));
  const sessionOpening = (
    options.resume
      ? { verb: "session/resume", result: result as unknown as SessionResumeResult }
      : { verb: "session/start", result: result as unknown as SessionStartResult }
  ) satisfies SessionOpening;
  const sessionId = sessionOpening.result.session.sessionId;

  const live = new Session({
    sessionId,
    durability: readSessionDurability(handshake),
    connection,
    opening: sessionOpening,
  });
  live.onGapError((error) => void run(Effect.logWarning("Muse could not fill a delivery gap", error)));
  live.onApprovalError((error) => {
    if (abandoned.has(error.approvalId)) return;
    void run(Effect.logWarning("A Muse approval round trip failed", error));
  });

  const decide = (request: ApprovalRequestParams) =>
    Effect.gen(function* () {
      if (isTrustedTool(request, trusted)) {
        const choice = pickApprovalChoice(request.availableChoices, { decision: "allow", scope: "session" });
        if (choice !== undefined) return { choiceId: choice.choiceId } satisfies ApprovalDecisionInput;
      }
      // One request per approval stage: a compound shell command can ask about each of its stages.
      const requestId = `${request.approvalId}:${request.currentRequirementId.sourceIndex}`;
      const verdict = Deferred.makeUnsafe<Verdict>();
      pendingApprovals.set(requestId, { approvalId: request.approvalId, verdict });
      emit([
        {
          payload: {
            _tag: "PermissionRequested",
            requestId,
            toolName: request.toolName || request.subject.kind,
            summary: approvalSummary(request),
            input: { subject: request.subject, arguments: request.rawArgs },
          },
          raw: request,
        },
      ]);
      const answer = yield* Deferred.await(verdict).pipe(
        Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))),
      );
      const resolved = (outcome: Pick<PermissionDecision, "decision" | "scope">) =>
        emit([{ payload: { _tag: "PermissionResolved", requestId, ...outcome }, raw: answer }]);
      if (answer.by === "elsewhere") {
        resolved(answer.outcome);
        // Throwing makes the SDK author no decision for an approval that is already closed.
        return yield* Effect.die(new Error(`approval ${request.approvalId} was resolved elsewhere`));
      }
      const choice = pickApprovalChoice(request.availableChoices, answer.decision);
      if (choice === undefined) {
        abandoned.add(request.approvalId);
        resolved({ decision: "deny", scope: "once" });
        return yield* Effect.die(
          new Error(`approval ${request.approvalId} offered no choice Cerium can use`),
        );
      }
      const outcome = choiceOutcome(choice);
      resolved(outcome);
      const feedback =
        outcome.decision === "deny" && choice.acceptsFeedback ? answer.decision.message : undefined;
      return { choiceId: choice.choiceId, ...(feedback ? { feedback } : {}) } satisfies ApprovalDecisionInput;
    });
  live.onApproval((request) => run(decide(request)));

  session = live;
  for (const frame of opening.splice(0)) {
    if (frame.params?.["sessionId"] === sessionId) apply(live, frame);
  }

  // The selected model's catalog row says which effort tiers it offers.
  let offeredEfforts: ReadonlyArray<string> | undefined;
  const loadEfforts = (model: string) =>
    Effect.tryPromise({
      try: () => connection.request("model/list", { sessionId }),
      catch: (cause) => new MuseCallError({ cause }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ModelList)),
      Effect.map((list) => {
        const row =
          list.models.find((entry) => entry.isActive === true) ??
          list.models.find((entry) => entry.modelId === model);
        offeredEfforts = Array.isArray(row?.variants) ? row.variants : undefined;
        translator.window(row?.contextLimit ?? undefined);
      }),
      Effect.ignore,
    );
  const setModel = (model: string) =>
    command("session/setModel", { sessionId, model: { modelId: model } }).pipe(
      Effect.mapError(failure("Could not switch the Muse model")),
      Effect.andThen(loadEfforts(model)),
    );
  const setEffort = (effort: ReasoningEffort) =>
    command("session/setReasoningEffort", {
      sessionId,
      reasoningEffort: toMuseEffort(effort, offeredEfforts),
    }).pipe(Effect.mapError(failure("Could not change Muse's effort")), Effect.asVoid);

  // A resumed session keeps its own approval mode and model; bring both in line with this agent.
  if (options.resume) {
    yield* command("session/setApprovalMode", { sessionId, mode: policy.approvalMode }).pipe(
      Effect.mapError(failure("Could not set the Muse approval mode")),
    );
    const standing = sessionOpening.result.session.modelId;
    if (overrides.provider !== "echo" && standing !== options.model) yield* setModel(options.model);
  }
  if (offeredEfforts === undefined) yield* loadEfforts(options.model);
  if (options.effort) yield* setEffort(options.effort);
  emit([translator.started(sessionId, options.model, options.effort)]);

  // A host that dies on its own ends every open turn and the session.
  void host.spawned.child.exit.then((exit) => {
    if (closing) return;
    live.hostExited(exit);
    emit(translator.endOpenTurns(`Muse Code exited unexpectedly (${exitSummary(exit)})`, exit));
    for (const pending of pendingApprovals.values()) {
      abandoned.add(pending.approvalId);
      Deferred.doneUnsafe(
        pending.verdict,
        Effect.succeed({ by: "elsewhere", outcome: { decision: "deny", scope: "once" } }),
      );
    }
    Queue.endUnsafe(events);
  });
  void connection.closed.then(() => {
    if (!closing) live.hostExited({ kind: "transportEof" });
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closing = true;
      for (const pending of pendingApprovals.values()) {
        Deferred.doneUnsafe(
          pending.verdict,
          Effect.succeed({ by: "cerium", decision: { decision: "deny", scope: "once" } }),
        );
      }
    }),
  );

  /** The SDK's turn-wait backs up the live feed: it also folds pages fetched after a delivery gap. */
  const watchTurn = (turnId: string) => {
    live.turn(turnId).completed.then(
      (outcome) => emit(translator.settled(turnId, outcome)),
      (error: unknown) =>
        emit(
          translator.endTurn(
            turnId,
            "error",
            { turnId, error: describe(error) },
            {
              _tag: "AgentError",
              kind: "crash",
              message: `Muse Code lost the turn: ${describe(error)}`,
              retryable: true,
            },
          ),
        ),
    );
  };

  const stopTurn = (method: "turn/interrupt" | "turn/unqueue", turnId: string) =>
    command(method, { sessionId, turnId }).pipe(Effect.asVoid);

  return {
    events: Stream.fromQueue(events),
    send: (text, extras) =>
      Effect.suspend(() => {
        // `turnId` is the submitting `commandId` for a fresh turn, so the turn is known before its frames.
        const commandId = connection.mintCommandId();
        translator.expectTurn(commandId);
        overrides.record?.({ cerium: "expectTurn", turnId: commandId });
        return command(
          "turn/start",
          { sessionId, input: toTurnInput(text, extras), ifBusy: "queue" },
          commandId,
        ).pipe(
          Effect.map((ack) => {
            const turnId = typeof ack["turnId"] === "string" ? ack["turnId"] : commandId;
            translator.renameTurn(commandId, turnId);
            if (turnId !== commandId)
              overrides.record?.({ cerium: "renameTurn", from: commandId, to: turnId });
            watchTurn(turnId);
          }),
          // A refused turn still ends, so the orchestrator never waits on it.
          Effect.catch(({ cause }) =>
            Effect.sync(() =>
              emit(
                translator.endTurn(
                  commandId,
                  "error",
                  { method: "turn/start", error: describe(cause) },
                  {
                    _tag: "AgentError",
                    kind: cause instanceof MspError ? (cause.retryable ? "transient" : "unknown") : "crash",
                    message: `Muse Code refused the turn: ${describe(cause)}`,
                    retryable: cause instanceof MspError ? cause.retryable === true : true,
                  },
                ),
              ),
            ),
          ),
        );
      }),
    respondToPermission: (requestId, decision) =>
      Effect.sync(() => {
        const pending = pendingApprovals.get(requestId);
        if (pending !== undefined)
          Deferred.doneUnsafe(pending.verdict, Effect.succeed({ by: "cerium", decision }));
      }),
    // A launched turn is interrupted; a queued one is reclaimed, or interrupted if it launched meanwhile.
    // Either way its terminal frame ends the turn. A refusal means there was nothing left to stop.
    interrupt: Effect.suspend(() =>
      Effect.forEach(
        translator.openTurns,
        ({ turnId, launched }) =>
          (launched
            ? stopTurn("turn/interrupt", turnId)
            : stopTurn("turn/unqueue", turnId).pipe(Effect.catch(() => stopTurn("turn/interrupt", turnId)))
          ).pipe(
            Effect.catch((error) =>
              refusedByMuse(error)
                ? Effect.void
                : Effect.fail(failure("Could not interrupt Muse")(error.cause)),
            ),
          ),
        { discard: true },
      ),
    ),
    // The task's item completes as stopped, which drops it from the background set.
    stopBackgroundTask: (taskId) =>
      command("task/stop", { sessionId, taskId }, connection.mintCommandId()).pipe(
        Effect.mapError(({ cause }) => failure("Could not stop the Muse background task")(cause)),
        Effect.asVoid,
      ),
    setModel: (model) => setModel(model),
    setEffort: (effort) => setEffort(effort),
    // Muse compacts outside any turn and acks only the admission; the compaction's terminal item
    // ends the turn Cerium counts it as. A noop ack is the whole answer.
    compact: Effect.suspend(() => {
      translator.compactAsked();
      return command("session/compact", { sessionId }, connection.mintCommandId()).pipe(
        Effect.map((ack) => {
          if (ack["status"] !== "noop") return;
          const reason = typeof ack["reason"] === "string" ? ` (${ack["reason"]})` : "";
          emit(translator.compactRefused(`Muse Code found nothing to compact${reason}.`, ack));
        }),
        Effect.catch(({ cause }) =>
          Effect.sync(() =>
            emit(
              translator.compactRefused(`Muse Code refused to compact: ${describe(cause)}`, {
                method: "session/compact",
                error: describe(cause),
              }),
            ),
          ),
        ),
      );
    }),
  } satisfies AgentSession;
});
