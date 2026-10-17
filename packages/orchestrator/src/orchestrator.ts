import type { AgentSession, PermissionDecision } from "@cerium/harness";
import {
  LEAD_ROLE,
  narrowAccess,
  type AccessMode,
  type AgentEvent,
  type AgentId,
  type AgentInfo,
  type AgentState,
  type EventId,
  type EventPayload,
  type InputItem,
  type ProviderId,
  type ReasoningEffort,
  type ThreadId,
  type ThreadInfo,
  type ThreadMode,
} from "@cerium/protocol";
import { Store, type StoreError } from "@cerium/store";
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { notAllowed, notFound, OrchestratorError } from "./errors.ts";
import { renderTurn, systemPrompt, truncate } from "./prompts.ts";
import { Adapters, BusEndpoint, Catalog, OrchestratorConfig, type CatalogEntry } from "./services.ts";

export interface CreateThreadInput {
  readonly title: string;
  readonly mode: ThreadMode;
  /** Required for work threads: the folder the agents work in. */
  readonly cwd?: string;
  readonly lead: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly effort?: ReasoningEffort;
    readonly access: AccessMode;
  };
}

/** What a lead asks for through `spawn_agent`. */
export interface SpawnRequest {
  readonly role: string;
  /** A catalog alias, or a model id (with `provider` when it is not in the catalog). */
  readonly model: string;
  readonly provider?: ProviderId;
  readonly effort?: ReasoningEffort;
  readonly access?: AccessMode;
  readonly prompt: string;
}

export type SpawnOutcome =
  | { readonly _tag: "Spawned"; readonly agentId: AgentId }
  | { readonly _tag: "PendingApproval"; readonly requestId: string };

export interface SpawnApproval {
  readonly decision: "allow" | "deny";
  /** The user may approve with a different model than the lead asked for. */
  readonly replacement?: { readonly provider: ProviderId; readonly model: string };
}

interface SpawnTarget {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

/** A running agent: its harness session plus the inbox Cerium delivers turns from. */
interface Runtime {
  info: AgentInfo;
  readonly session: AgentSession;
  readonly inbox: Queue.Queue<InputItem>;
  readonly scope: Scope.Closeable;
  sequence: number;
  /** Completed when the current turn's `TurnCompleted` arrives (or the session ends). */
  turn: Deferred.Deferred<void> | undefined;
  /** The last completed message of the current turn, delivered to the lead when a child finishes. */
  lastMessage: string | undefined;
  ended: boolean;
}

const isDelta = (payload: EventPayload) =>
  payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta";

const unavailable = (error: StoreError) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    createThread(
      input: CreateThreadInput,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    sendUserMessage(agentId: AgentId, text: string): Effect.Effect<void, OrchestratorError>;
    respondToPermission(
      agentId: AgentId,
      requestId: string,
      decision: PermissionDecision,
    ): Effect.Effect<void, OrchestratorError>;
    resolveSpawnApproval(requestId: string, approval: SpawnApproval): Effect.Effect<void, OrchestratorError>;
    /** Interrupts the agent's current turn; children follow when configured or asked. */
    interruptAgent(
      agentId: AgentId,
      options?: { readonly includeChildren?: boolean },
    ): Effect.Effect<void, OrchestratorError>;
    /** Ends the agent's session. */
    stopAgent(agentId: AgentId): Effect.Effect<void, OrchestratorError>;
    readonly listThreads: Effect.Effect<ReadonlyArray<ThreadInfo>, OrchestratorError>;
    listAgents(threadId: ThreadId): Effect.Effect<ReadonlyArray<AgentInfo>, OrchestratorError>;
    /** Live events from every agent; subscribers see events published after they subscribe. */
    readonly events: Stream.Stream<AgentEvent>;

    // Bus-facing operations: `callerId` is the agent invoking the tool.
    readonly catalog: ReadonlyArray<CatalogEntry>;
    spawn(callerId: AgentId, request: SpawnRequest): Effect.Effect<SpawnOutcome, OrchestratorError>;
    sendMessage(callerId: AgentId, to: AgentId, text: string): Effect.Effect<void, OrchestratorError>;
    killChild(callerId: AgentId, childId: AgentId): Effect.Effect<void, OrchestratorError>;
    /** The agent record for a live agent. */
    agent(agentId: AgentId): Effect.Effect<AgentInfo, OrchestratorError>;
    /** Every persisted event in a thread, in order. */
    threadEvents(threadId: ThreadId): Effect.Effect<ReadonlyArray<AgentEvent>, OrchestratorError>;
    /** Whether any agent in the thread is waiting for the user to approve something. */
    awaitingApproval(threadId: ThreadId): boolean;
  }
>()("cerium/orchestrator/Orchestrator") {
  static readonly layer = Layer.effect(
    Orchestrator,
    Effect.gen(function* () {
      const store = yield* Store;
      const adapters = yield* Adapters;
      const { entries: catalog } = yield* Catalog;
      const bus = yield* BusEndpoint;
      const config = yield* OrchestratorConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const layerScope = yield* Scope.Scope;

      const runtimes = new Map<AgentId, Runtime>();
      const threadDirectories = new Map<ThreadId, string>();
      const threadModes = new Map<ThreadId, ThreadMode>();
      const pendingSpawns = new Map<string, { readonly leadId: AgentId; readonly request: SpawnRequest }>();
      /** Send times per `from->to` pair, for the message budget. */
      const sentMessages = new Map<string, Array<number>>();
      /** Permission requests each agent is waiting on. */
      const pendingPermissions = new Map<AgentId, Set<string>>();
      const feed = yield* PubSub.unbounded<AgentEvent>();

      // Sessions don't survive a restart, so agents a previous run left live are stopped.
      yield* store.stopLiveAgents(yield* Clock.currentTimeMillis).pipe(Effect.mapError(unavailable));
      const globalPermits = yield* Semaphore.make(config.globalConcurrency);
      const providerPermits = new Map(
        [...adapters].map(([provider, adapter]) => [
          provider,
          Semaphore.makeUnsafe(adapter.manifest.defaultConcurrency),
        ]),
      );

      const makeId = (prefix: string) =>
        crypto.randomUUIDv7().pipe(
          Effect.map((uuid) => `${prefix}_${uuid}`),
          Effect.orDie,
        );

      const runtime = (agentId: AgentId) =>
        Effect.fromNullishOr(runtimes.get(agentId)).pipe(
          Effect.mapError(() => notFound(`Agent ${agentId} is not running.`)),
        );

      const emit = (rt: Runtime, payload: EventPayload, raw?: unknown) =>
        Effect.gen(function* () {
          const sequence = rt.sequence++;
          const event: AgentEvent = {
            id: `${rt.info.id}:${sequence}` as EventId,
            threadId: rt.info.threadId,
            agentId: rt.info.id,
            sequence,
            at: yield* Clock.currentTimeMillis,
            payload,
            ...(raw === undefined ? {} : { raw }),
          };
          if (!isDelta(payload)) yield* store.appendEvents([event]).pipe(Effect.mapError(unavailable));
          yield* PubSub.publish(feed, event);
        });

      const setState = (rt: Runtime, state: AgentState) =>
        Effect.gen(function* () {
          if (rt.info.state === state) return;
          const updatedAt = yield* Clock.currentTimeMillis;
          rt.info = { ...rt.info, state, updatedAt };
          yield* store.updateAgent(rt.info.id, { state, updatedAt }).pipe(Effect.mapError(unavailable));
          yield* emit(rt, { _tag: "AgentStateChanged", state });
        });

      const deliver = (agentId: AgentId, item: InputItem) =>
        Effect.gen(function* () {
          const target = runtimes.get(agentId);
          if (target === undefined || target.ended) {
            return yield* Effect.logWarning(`Dropped ${item._tag} for ${agentId}: agent is not running`);
          }
          yield* Queue.offer(target.inbox, item);
        });

      const finishTurn = (rt: Runtime) =>
        rt.turn === undefined ? Effect.void : Deferred.succeed(rt.turn, undefined);

      const consumeEvents = (rt: Runtime) =>
        rt.session.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const { payload } = event;
              yield* emit(rt, payload, event.raw);
              switch (payload._tag) {
                case "SessionStarted": {
                  const updatedAt = yield* Clock.currentTimeMillis;
                  rt.info = { ...rt.info, providerSessionId: payload.providerSessionId, updatedAt };
                  yield* store
                    .updateAgent(rt.info.id, { providerSessionId: payload.providerSessionId, updatedAt })
                    .pipe(Effect.mapError(unavailable));
                  return;
                }
                case "MessageCompleted":
                  rt.lastMessage = payload.text;
                  return;
                case "PermissionRequested": {
                  const pending = pendingPermissions.get(rt.info.id) ?? new Set<string>();
                  pendingPermissions.set(rt.info.id, pending.add(payload.requestId));
                  return;
                }
                case "PermissionResolved":
                  pendingPermissions.get(rt.info.id)?.delete(payload.requestId);
                  return;
                case "TurnCompleted":
                  return yield* finishTurn(rt);
                default:
                  return;
              }
            }),
          ),
          Effect.catchCause((cause) => Effect.logError(`Agent ${rt.info.id} session failed`, cause)),
          Effect.ensuring(
            Effect.gen(function* () {
              rt.ended = true;
              yield* finishTurn(rt);
              if (rt.info.state !== "stopped") yield* setState(rt, "failed").pipe(Effect.ignore);
            }),
          ),
        );

      const runTurn = (rt: Runtime, items: readonly [InputItem, ...Array<InputItem>]) =>
        Effect.gen(function* () {
          yield* setState(rt, "running");
          rt.lastMessage = undefined;
          rt.turn = yield* Deferred.make<void>();
          yield* emit(rt, { _tag: "TurnInput", items });
          yield* rt.session.send(renderTurn(items));
          yield* Deferred.await(rt.turn);
          rt.turn = undefined;
        });

      /** Delivers inbox items as turns, one turn at a time, under the concurrency caps (§3.5, §3.6). */
      const turnLoop = (rt: Runtime) =>
        Effect.gen(function* () {
          const first = yield* Queue.take(rt.inbox);
          // Notices wait briefly so several arriving together become one turn; the user never waits.
          if (first._tag !== "FromUser") yield* Effect.sleep(config.batchWindow);
          const items = [first, ...(yield* Queue.clear(rt.inbox))] as const;
          if (rt.ended) return yield* Effect.interrupt;

          yield* setState(rt, "queued");
          const permits = providerPermits.get(rt.info.provider) ?? Semaphore.makeUnsafe(1);
          yield* runTurn(rt, items).pipe(permits.withPermits(1), globalPermits.withPermits(1));
          if (rt.ended) return yield* Effect.interrupt;
          yield* setState(rt, "idle");

          if (rt.info.parentId !== undefined) {
            yield* deliver(rt.info.parentId, {
              _tag: "ChildFinishedTurn",
              agentId: rt.info.id,
              role: rt.info.role,
              text: truncate(rt.lastMessage ?? "(no final message)", config.maxDeliveredChars),
            });
          }
        }).pipe(
          Effect.catchCause((cause) => Effect.logError(`Agent ${rt.info.id} turn failed`, cause)),
          Effect.forever,
        );

      const startRuntime = (info: AgentInfo, cwd: string, initial?: InputItem) =>
        Effect.gen(function* () {
          const adapter = adapters.get(info.provider);
          if (adapter === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${info.provider} adapter is installed.`,
            });
          }
          const scope = yield* Scope.fork(layerScope);
          const started = Effect.gen(function* () {
            const busSpec = yield* bus.register(info.id);
            yield* Scope.addFinalizer(scope, bus.unregister(info.id));
            const session = yield* adapter
              .startSession({
                cwd,
                model: info.model,
                ...(info.effort ? { effort: info.effort } : {}),
                access: info.access,
                mcpServers: { [bus.serverName]: busSpec },
                includeUserMcpServers: true,
                trustedMcpServers: [bus.serverName],
                appendSystemPrompt: systemPrompt(info, bus.serverName),
              })
              .pipe(
                Scope.provide(scope),
                Effect.mapError(
                  (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
                ),
              );
            const last = yield* store.lastSequence(info.id).pipe(Effect.mapError(unavailable));
            const rt: Runtime = {
              info,
              session,
              inbox: yield* Queue.unbounded<InputItem>(),
              scope,
              sequence: Option.match(last, { onNone: () => 0, onSome: (sequence) => sequence + 1 }),
              turn: undefined,
              lastMessage: undefined,
              ended: false,
            };
            runtimes.set(info.id, rt);
            yield* Effect.forkIn(consumeEvents(rt), scope);
            yield* Effect.forkIn(turnLoop(rt), scope);
            if (initial !== undefined) yield* Queue.offer(rt.inbox, initial);
            return rt;
          });
          return yield* started.pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        });

      const now = Clock.currentTimeMillis;

      const launchChild = (lead: Runtime, request: SpawnRequest, target: SpawnTarget) =>
        Effect.gen(function* () {
          const mode = threadModes.get(lead.info.threadId) ?? "work";
          const requested = request.access ?? lead.info.access;
          const createdAt = yield* now;
          const effort = target.effort;
          const child: AgentInfo = {
            id: (yield* makeId("agt")) as AgentId,
            threadId: lead.info.threadId,
            parentId: lead.info.id,
            role: request.role,
            provider: target.provider,
            model: target.model,
            ...(effort ? { effort } : {}),
            access: mode === "chat" ? "readOnly" : narrowAccess(lead.info.access, requested),
            state: "idle",
            createdAt,
            updatedAt: createdAt,
          };
          yield* store.createAgent(child).pipe(Effect.mapError(unavailable));
          yield* emit(lead, {
            _tag: "AgentSpawned",
            childId: child.id,
            role: child.role,
            provider: child.provider,
            model: child.model,
            access: child.access,
          });
          const cwd = threadDirectories.get(lead.info.threadId) ?? ".";
          yield* startRuntime(child, cwd, {
            _tag: "FromAgent",
            agentId: lead.info.id,
            threadId: lead.info.threadId,
            text: request.prompt,
          });
          return child.id;
        });

      const resolveTarget = (request: SpawnRequest): SpawnTarget | undefined => {
        const entry =
          catalog.find((candidate) => candidate.alias === request.model) ??
          catalog.find(
            (candidate) =>
              candidate.model === request.model &&
              (request.provider === undefined || candidate.provider === request.provider),
          );
        if (entry === undefined) return undefined;
        const effort = request.effort ?? entry.effort;
        return { provider: entry.provider, model: entry.model, ...(effort ? { effort } : {}) };
      };

      const stopRuntime = (rt: Runtime) =>
        Effect.gen(function* () {
          runtimes.delete(rt.info.id);
          pendingPermissions.delete(rt.info.id);
          yield* setState(rt, "stopped").pipe(Effect.ignore);
          rt.ended = true;
          yield* Scope.close(rt.scope, Exit.void);
        });

      const childrenOf = (leadId: AgentId) =>
        [...runtimes.values()].filter((candidate) => candidate.info.parentId === leadId);

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...runtimes.values()], stopRuntime, { discard: true }),
      );

      return Orchestrator.of({
        createThread: Effect.fn("Orchestrator.createThread")(function* (input: CreateThreadInput) {
          if (input.mode === "work" && input.cwd === undefined) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: "A work thread needs a folder.",
            });
          }
          const createdAt = yield* now;
          const threadId = (yield* makeId("thr")) as ThreadId;
          const thread: ThreadInfo = {
            id: threadId,
            title: input.title,
            mode: input.mode,
            ...(input.mode === "work" && input.cwd !== undefined ? { cwd: input.cwd } : {}),
            createdAt,
            updatedAt: createdAt,
          };
          const directory =
            input.cwd !== undefined && input.mode === "work"
              ? input.cwd
              : path.join(config.chatDirectory, threadId);
          if (input.mode === "chat") {
            yield* fs
              .makeDirectory(directory, { recursive: true })
              .pipe(
                Effect.mapError(
                  (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
                ),
              );
          }
          const effort = input.lead.effort;
          const lead: AgentInfo = {
            id: (yield* makeId("agt")) as AgentId,
            threadId,
            role: LEAD_ROLE,
            provider: input.lead.provider,
            model: input.lead.model,
            ...(effort ? { effort } : {}),
            access: input.mode === "chat" ? "readOnly" : input.lead.access,
            state: "idle",
            createdAt,
            updatedAt: createdAt,
          };
          yield* store.createThread(thread).pipe(Effect.mapError(unavailable));
          yield* store.createAgent(lead).pipe(Effect.mapError(unavailable));
          threadDirectories.set(threadId, directory);
          threadModes.set(threadId, input.mode);
          yield* startRuntime(lead, directory);
          return { thread, lead };
        }),

        sendUserMessage: (agentId, text) =>
          runtime(agentId).pipe(Effect.flatMap((rt) => Queue.offer(rt.inbox, { _tag: "FromUser", text }))),

        respondToPermission: (agentId, requestId, decision) =>
          runtime(agentId).pipe(Effect.flatMap((rt) => rt.session.respondToPermission(requestId, decision))),

        resolveSpawnApproval: Effect.fn("Orchestrator.resolveSpawnApproval")(function* (
          requestId: string,
          approval: SpawnApproval,
        ) {
          const pending = pendingSpawns.get(requestId);
          if (pending === undefined) return yield* notFound(`No spawn request ${requestId} is waiting.`);
          pendingSpawns.delete(requestId);
          const lead = yield* runtime(pending.leadId);
          yield* emit(lead, { _tag: "SpawnApprovalResolved", requestId, decision: approval.decision });
          if (approval.decision === "deny") {
            return yield* deliver(lead.info.id, {
              _tag: "SystemNotice",
              text: `The user declined spawning ${pending.request.model} as "${pending.request.role}".`,
            });
          }
          const effort = pending.request.effort;
          const target: SpawnTarget = {
            ...(approval.replacement ?? {
              provider: pending.request.provider ?? lead.info.provider,
              model: pending.request.model,
            }),
            ...(effort ? { effort } : {}),
          };
          const childId = yield* launchChild(lead, pending.request, target);
          yield* deliver(lead.info.id, {
            _tag: "SystemNotice",
            text: `The user approved your spawn request: agent ${childId} (${pending.request.role}) is running ${target.model}.`,
          });
        }),

        interruptAgent: Effect.fn("Orchestrator.interruptAgent")(function* (
          agentId: AgentId,
          options?: { readonly includeChildren?: boolean },
        ) {
          const rt = yield* runtime(agentId);
          yield* rt.session.interrupt.pipe(
            Effect.mapError(
              (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
            ),
          );
          if (options?.includeChildren ?? config.stopChildrenWithLead) {
            yield* Effect.forEach(
              childrenOf(agentId),
              (child) => child.session.interrupt.pipe(Effect.ignore),
              {
                discard: true,
              },
            );
          }
        }),

        stopAgent: (agentId) => runtime(agentId).pipe(Effect.flatMap(stopRuntime)),

        listThreads: store.listThreads.pipe(Effect.mapError(unavailable)),

        listAgents: (threadId) => store.listAgents(threadId).pipe(Effect.mapError(unavailable)),

        events: Stream.fromPubSub(feed),

        catalog,

        spawn: Effect.fn("Orchestrator.spawn")(function* (callerId: AgentId, request: SpawnRequest) {
          const lead = yield* runtime(callerId);
          if (lead.info.parentId !== undefined) {
            return yield* notAllowed("Only a thread's lead can spawn agents.");
          }
          const target = resolveTarget(request);
          if (target !== undefined) {
            return {
              _tag: "Spawned",
              agentId: yield* launchChild(lead, request, target),
            } satisfies SpawnOutcome;
          }
          if (request.provider === undefined) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `"${request.model}" is not in the catalog. Call list_models, or pass a provider to ask the user.`,
            });
          }
          if (!adapters.has(request.provider)) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${request.provider} adapter is installed.`,
            });
          }
          const requestId = yield* makeId("spawn");
          pendingSpawns.set(requestId, { leadId: callerId, request });
          yield* emit(lead, {
            _tag: "SpawnApprovalRequested",
            requestId,
            role: request.role,
            provider: request.provider,
            model: request.model,
          });
          return { _tag: "PendingApproval", requestId } satisfies SpawnOutcome;
        }),

        sendMessage: Effect.fn("Orchestrator.sendMessage")(function* (
          callerId: AgentId,
          to: AgentId,
          text: string,
        ) {
          const from = yield* runtime(callerId);
          const recipient = yield* runtime(to);
          const crossThread = from.info.threadId !== recipient.info.threadId;
          if (crossThread && (from.info.parentId !== undefined || recipient.info.parentId !== undefined)) {
            return yield* notAllowed(
              "Across threads only leads can message each other; ask that thread's lead.",
            );
          }
          if (text.length > config.maxDeliveredChars) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The message is ${text.length} characters; the limit is ${config.maxDeliveredChars}. Summarize it.`,
            });
          }
          const sentAt = yield* now;
          const key = `${callerId}->${to}`;
          const windowStart = sentAt - Duration.toMillis(config.messageBudget.window);
          const recent = (sentMessages.get(key) ?? []).filter((time) => time > windowStart);
          if (recent.length >= config.messageBudget.limit) {
            return yield* new OrchestratorError({
              reason: "budgetExceeded",
              message: `You have sent ${recent.length} messages to ${to} recently, the most allowed. Finish your task or wait.`,
            });
          }
          sentMessages.set(key, [...recent, sentAt]);
          yield* deliver(to, { _tag: "FromAgent", agentId: callerId, threadId: from.info.threadId, text });
        }),

        killChild: Effect.fn("Orchestrator.killChild")(function* (callerId: AgentId, childId: AgentId) {
          const child = yield* runtime(childId);
          if (child.info.parentId !== callerId) {
            return yield* notAllowed(`Agent ${childId} is not your child.`);
          }
          yield* stopRuntime(child);
        }),

        agent: (agentId) => runtime(agentId).pipe(Effect.map((rt) => rt.info)),

        threadEvents: (threadId) => store.listThreadEvents(threadId).pipe(Effect.mapError(unavailable)),

        awaitingApproval: (threadId) =>
          [...runtimes.values()].some(
            (rt) => rt.info.threadId === threadId && (pendingPermissions.get(rt.info.id)?.size ?? 0) > 0,
          ),
      });
    }),
  );
}
