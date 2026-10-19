import type { AgentSession, PermissionDecision, TurnExtras, TurnImage } from "@cerium/harness";
import {
  ADVISOR_ROLE,
  LEAD_ROLE,
  MAX_THREAD_TITLE,
  narrowAccess,
  type AccessMode,
  type AdvisorSettings,
  type AgentEvent,
  type Attachment,
  type AgentId,
  type AgentInfo,
  type AgentState,
  type EventId,
  type EventPayload,
  type FromUser,
  type InputItem,
  type Mention,
  type ProviderId,
  type ReasoningEffort,
  type ThreadId,
  type ThreadInfo,
  type ThreadMode,
  type ThreadOverview,
} from "@cerium/protocol";
import { Store, type StoreError, type ThreadPatch } from "@cerium/store";
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
import { Base64 } from "effect/encoding";

import { notAllowed, notFound, OrchestratorError } from "./errors.ts";
import { renderTurn, systemPrompt, truncate, type Neighbour } from "./prompts.ts";
import { Adapters, BusEndpoint, Catalog, OrchestratorConfig, type CatalogEntry } from "./services.ts";
import { UserSettings } from "./settings.ts";
import { ThreadTitles } from "./titles.ts";

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

/** What the user sent beside the text of a message. */
export interface UserMessageExtras {
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly mentions?: ReadonlyArray<Mention>;
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

/** A live agent: the inbox Cerium delivers turns from, and its harness session once that has started. */
interface Runtime {
  info: AgentInfo;
  /** Undefined while the harness session starts; messages wait in the inbox meanwhile. */
  session: AgentSession | undefined;
  /** Settles once the session has started, or failed to. */
  readonly started: Deferred.Deferred<AgentSession, OrchestratorError>;
  readonly inbox: Queue.Queue<InputItem>;
  readonly scope: Scope.Closeable;
  sequence: number;
  /** Completed when the current turn's `TurnCompleted` arrives (or the session ends). */
  turn: Deferred.Deferred<void> | undefined;
  /** The last completed message of the current turn, delivered to the lead when a child finishes. */
  lastMessage: string | undefined;
  ended: boolean;
}

/** A thread's advisor: the read-only child Cerium starts for `ask_advisor`. */
const isAdvisor = (info: AgentInfo) => info.parentId !== undefined && info.role === ADVISOR_ROLE;

const isImage = (attachment: Attachment) => attachment.mediaType.startsWith("image/");

/** Events the store never keeps: streamed text, and new titles, which the thread's record holds. */
const isEphemeral = (payload: EventPayload) =>
  payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta" || payload._tag === "ThreadRenamed";

/**
 * Read-only agents never wait on the user: each harness already keeps them from
 * writing, so Cerium approves what they ask itself. Tools of the user's own MCP servers still ask,
 * since those can change things outside Cerium; every adapter names them `mcp__<server>…`.
 */
const approvesItself = (access: AccessMode, toolName: string) =>
  access === "readOnly" && !toolName.startsWith("mcp__");

const unavailable = (error: StoreError) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

export class Orchestrator extends Context.Service<
  Orchestrator,
  {
    createThread(
      input: CreateThreadInput,
    ): Effect.Effect<{ readonly thread: ThreadInfo; readonly lead: AgentInfo }, OrchestratorError>;
    /** Delivers the user's message to a lead, resuming its harness session if it stopped or failed. */
    sendUserMessage(
      agentId: AgentId,
      text: string,
      extras?: UserMessageExtras,
    ): Effect.Effect<void, OrchestratorError>;
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
    /** Renames a thread; the title is trimmed and must be 1 to `MAX_THREAD_TITLE` characters. */
    renameThread(threadId: ThreadId, title: string): Effect.Effect<ThreadInfo, OrchestratorError>;
    /**
     * Archives or restores a thread. One whose agents are working or waiting on the user can't be
     * archived, so a request never ends up where the user doesn't look.
     */
    setThreadArchived(threadId: ThreadId, archived: boolean): Effect.Effect<ThreadInfo, OrchestratorError>;
    /**
     * Deletes a thread for good: its agents' sessions end and its agents and events are removed.
     * Refused while its agents work or wait on the user, like archiving.
     */
    deleteThread(threadId: ThreadId): Effect.Effect<void, OrchestratorError>;
    listAgents(threadId: ThreadId): Effect.Effect<ReadonlyArray<AgentInfo>, OrchestratorError>;
    /** Every thread with its agents and whether it waits on the user, oldest first, read at once. */
    readonly threadOverviews: Effect.Effect<ReadonlyArray<ThreadOverview>, OrchestratorError>;
    /** Live events from every agent; subscribers see events published after they subscribe. */
    readonly events: Stream.Stream<AgentEvent>;

    // Bus-facing operations: `callerId` is the agent invoking the tool.
    readonly catalog: ReadonlyArray<CatalogEntry>;
    spawn(callerId: AgentId, request: SpawnRequest): Effect.Effect<SpawnOutcome, OrchestratorError>;
    sendMessage(callerId: AgentId, to: AgentId, text: string): Effect.Effect<void, OrchestratorError>;
    killChild(callerId: AgentId, childId: AgentId): Effect.Effect<void, OrchestratorError>;
    /**
     * Puts a question to the thread's advisor, starting one on the model the user picked when none
     * runs. Returns at once; the answer reaches the caller later, as a message from the advisor.
     */
    askAdvisor(
      callerId: AgentId,
      question: string,
    ): Effect.Effect<{ readonly advisorId: AgentId }, OrchestratorError>;
    /** The agent record for a live agent. */
    agent(agentId: AgentId): Effect.Effect<AgentInfo, OrchestratorError>;
    /** Hands a live agent a Cerium notice, delivered like any message: as its next turn's input. */
    notify(agentId: AgentId, text: string): Effect.Effect<void>;
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
      const settings = yield* UserSettings;
      const titles = yield* ThreadTitles;
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
      /** Each thread's live advisor. */
      const advisors = new Map<ThreadId, Runtime>();
      /** The agents waiting on each advisor's answers, in the order they asked. */
      const advisorQuestions = new Map<AgentId, Array<AgentId>>();
      /** One advisor starts at a time, so agents asking together share it. */
      const advisorPermit = yield* Semaphore.make(1);
      const feed = yield* PubSub.unbounded<AgentEvent>();
      /** Threads still waiting for their first message to name them, with the title they started with. */
      const untitled = new Map<ThreadId, string>();

      // Sessions don't survive a restart, so agents a previous run left live are stopped; a lead
      // resumes its harness session when the user next messages it.
      yield* store.stopLiveAgents(yield* Clock.currentTimeMillis).pipe(Effect.mapError(unavailable));
      const globalPermits = yield* Semaphore.make(config.globalConcurrency);
      /**
       * One user message accepted at a time, so messages sent together keep their order and don't
       * start two sessions for one lead.
       */
      const acceptPermit = yield* Semaphore.make(1);
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
          if (!isEphemeral(payload)) yield* store.appendEvents([event]).pipe(Effect.mapError(unavailable));
          yield* PubSub.publish(feed, event);
        });

      const deliver = (agentId: AgentId, item: InputItem) =>
        Effect.gen(function* () {
          const target = runtimes.get(agentId);
          if (target === undefined || target.ended) {
            return yield* Effect.logWarning(`Dropped ${item._tag} for ${agentId}: agent is not running`);
          }
          yield* Queue.offer(target.inbox, item);
        });

      /** An advisor that ended answers nobody: the agents still waiting on it hear so, and ask anew. */
      const releaseAdvisor = (rt: Runtime) =>
        Effect.gen(function* () {
          const waiting = advisorQuestions.get(rt.info.id) ?? [];
          advisorQuestions.delete(rt.info.id);
          if (advisors.get(rt.info.threadId) === rt) advisors.delete(rt.info.threadId);
          yield* Effect.forEach(
            new Set(waiting),
            (asker) =>
              deliver(asker, {
                _tag: "SystemNotice",
                text: "The advisor ended before it answered your question. Ask again with `ask_advisor` if you still need an answer.",
              }),
            { discard: true },
          );
        });

      const setState = (rt: Runtime, state: AgentState) =>
        Effect.gen(function* () {
          if (rt.info.state === state) return;
          const updatedAt = yield* Clock.currentTimeMillis;
          rt.info = { ...rt.info, state, updatedAt };
          yield* store.updateAgent(rt.info.id, { state, updatedAt }).pipe(Effect.mapError(unavailable));
          yield* emit(rt, { _tag: "AgentStateChanged", state });
          if (isAdvisor(rt.info) && (state === "stopped" || state === "failed")) yield* releaseAdvisor(rt);
        });

      const finishTurn = (rt: Runtime) =>
        rt.turn === undefined ? Effect.void : Deferred.succeed(rt.turn, undefined);

      const consumeEvents = (rt: Runtime, session: AgentSession) => {
        /** Requests Cerium approved itself: nobody was asked, so neither end is recorded or shown. */
        const approvedByCerium = new Set<string>();
        return session.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const { payload } = event;
              if (
                payload._tag === "PermissionRequested" &&
                approvesItself(rt.info.access, payload.toolName)
              ) {
                approvedByCerium.add(payload.requestId);
                return yield* session.respondToPermission(payload.requestId, {
                  decision: "allow",
                  scope: "once",
                });
              }
              if (payload._tag === "PermissionResolved" && approvedByCerium.delete(payload.requestId)) return;
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
      };

      /** The images and skills a turn's user messages carry, as harnesses take them. */
      const turnExtras = (rt: Runtime, items: ReadonlyArray<InputItem>) =>
        Effect.gen(function* () {
          const fromUser = items.flatMap((item) => (item._tag === "FromUser" ? [item] : []));
          const takesImages = adapters.get(rt.info.provider)?.manifest.input.images === true;
          const read = yield* Effect.forEach(
            takesImages ? fromUser.flatMap((item) => (item.attachments ?? []).filter(isImage)) : [],
            (attachment) =>
              fs.readFile(attachment.path).pipe(
                Effect.map((bytes): TurnImage => ({
                  path: attachment.path,
                  mediaType: attachment.mediaType,
                  data: Base64.encode(bytes),
                })),
                // An image that can't be read any more is still named in the text.
                Effect.option,
              ),
          );
          const images = read.flatMap(Option.toArray);
          const skills = fromUser.flatMap((item) =>
            (item.mentions ?? []).flatMap((mention) =>
              mention._tag === "SkillMention"
                ? [{ name: mention.name, ...(mention.path ? { path: mention.path } : {}) }]
                : [],
            ),
          );
          if (images.length === 0 && skills.length === 0) return undefined;
          return {
            ...(images.length > 0 ? { images } : {}),
            ...(skills.length > 0 ? { skills } : {}),
          } satisfies TurnExtras;
        });

      const runTurn = (
        rt: Runtime,
        session: AgentSession,
        items: readonly [InputItem, ...Array<InputItem>],
      ) =>
        Effect.gen(function* () {
          yield* setState(rt, "running");
          rt.lastMessage = undefined;
          rt.turn = yield* Deferred.make<void>();
          yield* emit(rt, { _tag: "TurnInput", items });
          yield* session.send(renderTurn(items), yield* turnExtras(rt, items)).pipe(
            // A turn the harness refused never ends on its own, leaving the agent working with
            // nothing to stop; it ends here with the reason.
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* emit(rt, {
                  _tag: "AgentError",
                  kind: "unknown",
                  message: error.message,
                  retryable: false,
                });
                yield* emit(rt, { _tag: "TurnCompleted", stopReason: "error" });
                yield* finishTurn(rt);
              }),
            ),
          );
          yield* Deferred.await(rt.turn);
          rt.turn = undefined;
        });

      /** Delivers inbox items as turns, one turn at a time, under the concurrency caps. */
      const turnLoop = (rt: Runtime) =>
        Effect.gen(function* () {
          const first = yield* Queue.take(rt.inbox);
          // An advisor answers one question a turn, each to the agent that asked it.
          const advisor = isAdvisor(rt.info);
          // Notices wait briefly so several arriving together become one turn; the user never waits.
          if (first._tag !== "FromUser" && !advisor) yield* Effect.sleep(config.batchWindow);
          const items = advisor ? ([first] as const) : ([first, ...(yield* Queue.clear(rt.inbox))] as const);
          if (rt.ended) return yield* Effect.interrupt;

          yield* setState(rt, "queued");
          // A session that never started took nothing: what the user sent waits for the next start.
          const session = yield* Deferred.await(rt.started).pipe(
            Effect.tapError(() => setState(rt, "failed")),
          );
          const permits = providerPermits.get(rt.info.provider) ?? Semaphore.makeUnsafe(1);
          yield* runTurn(rt, session, items).pipe(permits.withPermits(1), globalPermits.withPermits(1));
          if (rt.ended) return yield* Effect.interrupt;
          yield* setState(rt, "idle");

          if (advisor) {
            if (first._tag !== "FromAgent") return;
            const waiting = advisorQuestions.get(rt.info.id) ?? [];
            const index = waiting.indexOf(first.agentId);
            if (index !== -1) waiting.splice(index, 1);
            yield* deliver(first.agentId, {
              _tag: "FromAgent",
              agentId: rt.info.id,
              threadId: rt.info.threadId,
              text: truncate(rt.lastMessage ?? "(no answer)", config.maxDeliveredChars),
            });
          } else if (rt.info.parentId !== undefined) {
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

      /**
       * The other work threads whose leads are live in a lead's folder, for its prompt: their agents may
       * be changing the same files.
       */
      const neighboursOf = (info: AgentInfo, cwd: string) =>
        Effect.gen(function* () {
          if (info.parentId !== undefined || threadModes.get(info.threadId) !== "work") return [];
          const live = [...runtimes.values()].filter((rt) => {
            const folder = threadDirectories.get(rt.info.threadId);
            return (
              rt.info.parentId === undefined &&
              rt.info.threadId !== info.threadId &&
              !rt.ended &&
              threadModes.get(rt.info.threadId) === "work" &&
              folder !== undefined &&
              path.relative(folder, cwd) === ""
            );
          });
          if (live.length === 0) return [];
          const threads = yield* store.listThreads.pipe(Effect.orElseSucceed(() => []));
          return live.flatMap((rt): ReadonlyArray<Neighbour> => {
            const thread = threads.find((candidate) => candidate.id === rt.info.threadId);
            return thread === undefined || thread.archivedAt !== undefined
              ? []
              : [{ title: thread.title, leadId: rt.info.id, model: rt.info.model, state: rt.info.state }];
          });
        });

      /**
       * Makes an agent live at once, so it takes messages straight away; its harness session starts
       * behind it, and a failure to start is told in its transcript.
       */
      const startRuntime = (
        info: AgentInfo,
        cwd: string,
        options: { readonly initial?: InputItem; readonly resume?: string } = {},
      ) =>
        Effect.gen(function* () {
          const adapter = adapters.get(info.provider);
          if (adapter === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${info.provider} adapter is installed.`,
            });
          }
          const last = yield* store.lastSequence(info.id).pipe(Effect.mapError(unavailable));
          const scope = yield* Scope.fork(layerScope);
          const rt: Runtime = {
            info,
            session: undefined,
            started: yield* Deferred.make<AgentSession, OrchestratorError>(),
            inbox: yield* Queue.unbounded<InputItem>(),
            scope,
            sequence: Option.match(last, { onNone: () => 0, onSome: (sequence) => sequence + 1 }),
            turn: undefined,
            lastMessage: undefined,
            ended: false,
          };
          runtimes.set(info.id, rt);

          const start = Effect.gen(function* () {
            const { includeUserMcpServers, advisor } = yield* settings.get;
            const neighbours = yield* neighboursOf(info, cwd);
            const busSpec = yield* bus.register(info.id);
            yield* Scope.addFinalizer(scope, bus.unregister(info.id));
            const session = yield* adapter
              .startSession({
                cwd,
                model: info.model,
                ...(info.effort ? { effort: info.effort } : {}),
                ...(options.resume ? { resume: options.resume } : {}),
                access: info.access,
                mcpServers: { [bus.serverName]: busSpec },
                includeUserMcpServers,
                trustedMcpServers: [bus.serverName],
                appendSystemPrompt: systemPrompt(info, bus.serverName, {
                  advisor: advisor.enabled && advisor.model !== undefined,
                  neighbours,
                }),
              })
              .pipe(
                Scope.provide(scope),
                Effect.mapError(
                  (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
                ),
              );
            rt.session = session;
            yield* Effect.forkIn(consumeEvents(rt, session), scope);
            yield* Deferred.succeed(rt.started, session);
          });
          yield* Effect.forkIn(
            start.pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  rt.ended = true;
                  yield* emit(rt, {
                    _tag: "AgentError",
                    kind: "unknown",
                    message: error.message,
                    retryable: false,
                  });
                  yield* setState(rt, "failed");
                }).pipe(Effect.ensuring(Deferred.fail(rt.started, error)), Effect.ignore),
              ),
            ),
            scope,
          );
          yield* Effect.forkIn(turnLoop(rt), scope);
          if (options.initial !== undefined) yield* Queue.offer(rt.inbox, options.initial);
          return rt;
        });

      const now = Clock.currentTimeMillis;

      const awaitingApproval = (threadId: ThreadId) =>
        [...runtimes.values()].some(
          (rt) => rt.info.threadId === threadId && (pendingPermissions.get(rt.info.id)?.size ?? 0) > 0,
        );

      const waitsOnUser = (threadId: ThreadId) =>
        awaitingApproval(threadId) ||
        [...pendingSpawns.values()].some(({ leadId }) => runtimes.get(leadId)?.info.threadId === threadId);

      const working = (threadId: ThreadId) =>
        [...runtimes.values()].some(
          (rt) =>
            rt.info.threadId === threadId && (rt.info.state === "running" || rt.info.state === "queued"),
        );

      /** Applies a change to a stored thread; renaming and archiving don't count as activity. */
      const updateThread = (threadId: ThreadId, patch: ThreadPatch) =>
        Effect.gen(function* () {
          yield* store.updateThread(threadId, patch).pipe(Effect.mapError(unavailable));
          const thread = Option.getOrUndefined(
            yield* store.getThread(threadId).pipe(Effect.mapError(unavailable)),
          );
          if (thread === undefined) return yield* notFound(`Thread ${threadId} does not exist.`);
          return thread;
        });

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
            initial: {
              _tag: "FromAgent",
              agentId: lead.info.id,
              threadId: lead.info.threadId,
              text: request.prompt,
            },
          });
          return child.id;
        });

      /**
       * The thread's advisor, started as a read-only child of its lead when none runs. A new pick in
       * settings takes over once the running advisor has answered what it was asked.
       */
      const advisorFor = (asker: Runtime, chosen: NonNullable<AdvisorSettings["model"]>) =>
        Effect.gen(function* () {
          const { threadId } = asker.info;
          const live = advisors.get(threadId);
          if (live !== undefined && !live.ended) {
            const picked =
              live.info.provider === chosen.provider &&
              live.info.model === chosen.model &&
              live.info.effort === chosen.effort;
            if (picked || (advisorQuestions.get(live.info.id)?.length ?? 0) > 0) return live;
            yield* stopRuntime(live);
          }
          const leadId = asker.info.parentId ?? asker.info.id;
          const createdAt = yield* now;
          const info: AgentInfo = {
            id: (yield* makeId("agt")) as AgentId,
            threadId,
            parentId: leadId,
            role: ADVISOR_ROLE,
            provider: chosen.provider,
            model: chosen.model,
            ...(chosen.effort ? { effort: chosen.effort } : {}),
            access: "readOnly",
            state: "idle",
            createdAt,
            updatedAt: createdAt,
          };
          yield* store.createAgent(info).pipe(Effect.mapError(unavailable));
          const lead = runtimes.get(leadId);
          if (lead !== undefined) {
            yield* emit(lead, {
              _tag: "AgentSpawned",
              childId: info.id,
              role: info.role,
              provider: info.provider,
              model: info.model,
              access: info.access,
            });
          }
          const rt = yield* startRuntime(info, threadDirectories.get(threadId) ?? ".");
          advisors.set(threadId, rt);
          return rt;
        });

      /** Counts one more message from `key`'s sender against the per-pair budget. */
      const spendBudget = (key: string, to: string) =>
        Effect.gen(function* () {
          const sentAt = yield* now;
          const windowStart = sentAt - Duration.toMillis(config.messageBudget.window);
          const recent = (sentMessages.get(key) ?? []).filter((time) => time > windowStart);
          if (recent.length >= config.messageBudget.limit) {
            return yield* new OrchestratorError({
              reason: "budgetExceeded",
              message: `You have sent ${recent.length} messages to ${to} recently, the most allowed. Finish your task or wait.`,
            });
          }
          sentMessages.set(key, [...recent, sentAt]);
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

      /**
       * Starts a stopped or failed lead again on its harness session, so the thread carries on with
       * the context it had; a lead whose session never started gets a new one. Returns the user's
       * messages the old runtime never delivered, and notices the lead's next turn should carry.
       */
      const resumeLead = Effect.fn("Orchestrator.resumeLead")(function* (agentId: AgentId) {
        const previous = runtimes.get(agentId);
        const info =
          previous?.info ??
          Option.getOrUndefined(yield* store.getAgent(agentId).pipe(Effect.mapError(unavailable)));
        if (info === undefined) return yield* notFound(`Agent ${agentId} does not exist.`);
        if (info.parentId !== undefined) {
          return yield* notAllowed(`${info.model} has stopped; only a thread's lead can be resumed.`);
        }
        const adapter = adapters.get(info.provider);
        if (
          info.providerSessionId !== undefined &&
          adapter !== undefined &&
          !adapter.manifest.session.resume
        ) {
          return yield* new OrchestratorError({
            reason: "unavailable",
            message: `${info.provider} sessions can't be resumed.`,
          });
        }
        const thread = Option.getOrUndefined(
          yield* store.getThread(info.threadId).pipe(Effect.mapError(unavailable)),
        );
        if (thread === undefined) return yield* notFound(`Thread ${info.threadId} does not exist.`);
        const directory =
          thread.mode === "work" && thread.cwd !== undefined
            ? thread.cwd
            : path.join(config.chatDirectory, thread.id);
        threadDirectories.set(thread.id, directory);
        threadModes.set(thread.id, thread.mode);

        // A failed lead still holds its ended session and bus registration; release them first.
        if (previous !== undefined) {
          runtimes.delete(agentId);
          yield* Scope.close(previous.scope, Exit.void);
        }
        pendingPermissions.delete(agentId);
        const history = yield* store.listEvents(agentId).pipe(Effect.mapError(unavailable));
        const rt = yield* startRuntime(
          info,
          directory,
          info.providerSessionId === undefined ? {} : { resume: info.providerSessionId },
        );
        // Approvals the old session was waiting on died with it; messages it never took go to the new one.
        const unanswered = new Set<string>();
        const undelivered = new Map<string, InputItem>();
        for (const { payload } of history) {
          if (payload._tag === "PermissionRequested") unanswered.add(payload.requestId);
          if (payload._tag === "PermissionResolved") unanswered.delete(payload.requestId);
          if (payload._tag === "MessageQueued" && payload.message.id !== undefined) {
            undelivered.set(payload.message.id, payload.message);
          }
          if (payload._tag === "TurnInput") {
            for (const item of payload.items)
              if (item._tag === "FromUser" && item.id) undelivered.delete(item.id);
          }
        }
        yield* Effect.forEach(
          unanswered,
          (requestId) => emit(rt, { _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" }),
          { discard: true },
        );
        yield* setState(rt, "idle");

        const gone = (yield* store.listAgents(thread.id).pipe(Effect.mapError(unavailable))).filter(
          // The advisor isn't the lead's to spawn again: the next question starts a new one.
          (agent) => agent.parentId === agentId && !isAdvisor(agent) && !runtimes.has(agent.id),
        );
        const notices: Array<InputItem> =
          gone.length === 0
            ? []
            : [
                {
                  _tag: "SystemNotice",
                  text: `Your session was resumed after it ended. The agents you spawned before (${gone
                    .map((agent) => `${agent.id} "${agent.role}"`)
                    .join(", ")}) are no longer running; spawn new ones if you still need them.`,
                },
              ];
        return { rt, undelivered: [...undelivered.values()], notices };
      });

      /** The lead's live runtime, resuming its session first when it has stopped or failed. */
      const liveLead = (agentId: AgentId) =>
        Effect.suspend(() => {
          const live = runtimes.get(agentId);
          return live !== undefined && !live.ended
            ? Effect.succeed({
                rt: live,
                undelivered: [] as ReadonlyArray<InputItem>,
                notices: [] as ReadonlyArray<InputItem>,
              })
            : resumeLead(agentId);
        });

      /** The agent's harness session, which a live agent only lacks while it starts. */
      const sessionOf = (rt: Runtime) =>
        Effect.fromNullishOr(rt.session).pipe(
          Effect.mapError(() => notFound(`${rt.info.model} is still starting.`)),
        );

      const childrenOf = (leadId: AgentId) =>
        [...runtimes.values()].filter((candidate) => candidate.info.parentId === leadId);

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...runtimes.values()], stopRuntime, { discard: true }),
      );

      /**
       * Names a new thread from its first message while the lead works on it, unless the user
       * renamed the thread meanwhile. The lead's live feed tells the lists at once.
       */
      const nameThread = (
        lead: Runtime,
        startedAs: string,
        text: string,
        attachments: ReadonlyArray<Attachment>,
      ) =>
        Effect.gen(function* () {
          const { threadId, provider, model } = lead.info;
          const title = yield* titles.name({
            text,
            attachments: attachments.map((attachment) => attachment.name),
            lead: { provider, model },
          });
          if (Option.isNone(title)) return;
          const thread = yield* store.getThread(threadId).pipe(Effect.mapError(unavailable));
          if (Option.isNone(thread) || thread.value.title !== startedAs) return;
          yield* updateThread(threadId, { title: title.value });
          yield* emit(lead, { _tag: "ThreadRenamed", title: title.value });
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't name a thread", cause)));

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
          untitled.set(threadId, input.title);
          yield* startRuntime(lead, directory);
          return { thread, lead };
        }),

        sendUserMessage: (agentId, text, extras = {}) => {
          const { attachments = [], mentions = [] } = extras;
          if (text.trim() === "" && attachments.length === 0) {
            return Effect.fail(
              new OrchestratorError({ reason: "invalid", message: "The message is empty." }),
            );
          }
          return acceptPermit.withPermits(1)(
            Effect.gen(function* () {
              const { rt, undelivered, notices } = yield* liveLead(agentId);
              const message: FromUser = {
                _tag: "FromUser",
                id: yield* makeId("msg"),
                text,
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(mentions.length > 0 ? { mentions } : {}),
              };
              // Recorded before it waits on the session or a running turn, so the user sees it at once.
              yield* emit(rt, { _tag: "MessageQueued", message });
              // Offered together, so the user's messages and any notices make one turn.
              yield* Queue.offerAll(rt.inbox, [...undelivered, message, ...notices]);
              const startedAs = untitled.get(rt.info.threadId);
              untitled.delete(rt.info.threadId);
              if (startedAs !== undefined && text.trim() !== "") {
                yield* Effect.forkIn(nameThread(rt, startedAs, text, attachments), layerScope);
              }
            }),
          );
        },

        respondToPermission: (agentId, requestId, decision) =>
          runtime(agentId).pipe(
            Effect.flatMap(sessionOf),
            Effect.flatMap((session) => session.respondToPermission(requestId, decision)),
          ),

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
          // A session still starting has no turn to interrupt.
          yield* (rt.session?.interrupt ?? Effect.void).pipe(
            Effect.mapError(
              (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
            ),
          );
          if (options?.includeChildren ?? config.stopChildrenWithLead) {
            yield* Effect.forEach(
              childrenOf(agentId),
              (child) => (child.session?.interrupt ?? Effect.void).pipe(Effect.ignore),
              {
                discard: true,
              },
            );
          }
        }),

        stopAgent: Effect.fn("Orchestrator.stopAgent")(function* (agentId: AgentId) {
          const rt = yield* runtime(agentId);
          yield* stopRuntime(rt);
          // A lead waiting on this child would otherwise wait for a result that never comes. An
          // advisor's askers hear from `releaseAdvisor` instead.
          if (rt.info.parentId !== undefined && !isAdvisor(rt.info)) {
            yield* deliver(rt.info.parentId, {
              _tag: "SystemNotice",
              text: `The user stopped agent ${rt.info.id} "${rt.info.role}"; it will not report back. Carry on without it, or spawn a new agent if you still need that work.`,
            });
          }
        }),

        listThreads: store.listThreads.pipe(Effect.mapError(unavailable)),

        renameThread: (threadId, title) => {
          const trimmed = title.trim();
          if (trimmed === "" || trimmed.length > MAX_THREAD_TITLE) {
            return Effect.fail(
              new OrchestratorError({
                reason: "invalid",
                message: `A thread's title needs 1 to ${MAX_THREAD_TITLE} characters.`,
              }),
            );
          }
          return updateThread(threadId, { title: trimmed });
        },

        setThreadArchived: Effect.fn("Orchestrator.setThreadArchived")(function* (
          threadId: ThreadId,
          archived: boolean,
        ) {
          if (archived && (working(threadId) || waitsOnUser(threadId))) {
            return yield* notAllowed(
              "A thread can't be archived while its agents are working or waiting on you.",
            );
          }
          return yield* updateThread(threadId, { archivedAt: archived ? yield* now : null });
        }),

        deleteThread: Effect.fn("Orchestrator.deleteThread")(function* (threadId: ThreadId) {
          const thread = yield* store.getThread(threadId).pipe(Effect.mapError(unavailable));
          if (Option.isNone(thread)) return yield* notFound(`Thread ${threadId} does not exist.`);
          if (working(threadId) || waitsOnUser(threadId)) {
            return yield* notAllowed(
              "A thread can't be deleted while its agents are working or waiting on you.",
            );
          }
          // Sessions end first, so nothing they record lands after the rows are gone.
          yield* Effect.forEach(
            [...runtimes.values()].filter((rt) => rt.info.threadId === threadId),
            stopRuntime,
            { discard: true },
          );
          threadDirectories.delete(threadId);
          threadModes.delete(threadId);
          yield* store.deleteThread(threadId).pipe(Effect.mapError(unavailable));
        }),

        listAgents: (threadId) => store.listAgents(threadId).pipe(Effect.mapError(unavailable)),

        threadOverviews: Effect.gen(function* () {
          const threads = yield* store.listThreads;
          const byThread = Map.groupBy(yield* store.listAllAgents, (agent) => agent.threadId);
          return threads.map((thread): ThreadOverview => ({
            thread,
            agents: byThread.get(thread.id) ?? [],
            awaitingApproval: awaitingApproval(thread.id),
          }));
        }).pipe(Effect.mapError(unavailable)),

        events: Stream.fromPubSub(feed),

        catalog,

        spawn: Effect.fn("Orchestrator.spawn")(function* (callerId: AgentId, request: SpawnRequest) {
          const lead = yield* runtime(callerId);
          if (lead.info.parentId !== undefined) {
            return yield* notAllowed("Only a thread's lead can spawn agents.");
          }
          if (request.role === ADVISOR_ROLE) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The role "${ADVISOR_ROLE}" belongs to the user's advisor: ask it with \`ask_advisor\`, or give your agent another role.`,
            });
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
          const stopped = notFound(
            `Agent ${to} isn't running, so it can't take messages: it was stopped, or its thread waits for the user to pick it back up. \`list_threads\` shows which leads are working.`,
          );
          const recipient = yield* runtime(to).pipe(Effect.mapError(() => stopped));
          // An agent whose session ended would drop the message while the sender heard it was delivered.
          if (recipient.ended) return yield* stopped;
          if (isAdvisor(from.info)) {
            return yield* notAllowed(
              "An advisor only answers the question it was asked; your reply reaches the agent that asked it.",
            );
          }
          if (isAdvisor(recipient.info)) {
            return yield* notAllowed("Put questions to the advisor with `ask_advisor`.");
          }
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
          yield* spendBudget(`${callerId}->${to}`, to);
          yield* deliver(to, { _tag: "FromAgent", agentId: callerId, threadId: from.info.threadId, text });
        }),

        askAdvisor: Effect.fn("Orchestrator.askAdvisor")(function* (callerId: AgentId, question: string) {
          const asker = yield* runtime(callerId);
          if (isAdvisor(asker.info)) {
            return yield* notAllowed("You are the advisor: answer the question you were asked.");
          }
          const { advisor: chosen } = yield* settings.get;
          if (!chosen.enabled || chosen.model === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message:
                "The user hasn't turned on an advisor (Settings → Agents). Carry on, or ask the user instead.",
            });
          }
          if (!adapters.has(chosen.model.provider)) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `The advisor runs on ${chosen.model.provider}, and no ${chosen.model.provider} adapter is installed.`,
            });
          }
          if (question.length > config.maxDeliveredChars) {
            return yield* new OrchestratorError({
              reason: "invalid",
              message: `The question is ${question.length} characters; the limit is ${config.maxDeliveredChars}. Shorten it, and name files for the advisor to read instead of pasting them.`,
            });
          }
          yield* spendBudget(`${callerId}->${ADVISOR_ROLE}`, "the advisor");
          const model = chosen.model;
          return yield* advisorPermit.withPermits(1)(
            Effect.gen(function* () {
              const advisor = yield* advisorFor(asker, model);
              advisorQuestions.set(advisor.info.id, [
                ...(advisorQuestions.get(advisor.info.id) ?? []),
                callerId,
              ]);
              yield* deliver(advisor.info.id, {
                _tag: "FromAgent",
                agentId: callerId,
                threadId: asker.info.threadId,
                text: question,
              });
              // One that ended while the question was put to it would leave the asker waiting.
              if (advisor.ended) yield* releaseAdvisor(advisor);
              return { advisorId: advisor.info.id };
            }),
          );
        }),

        killChild: Effect.fn("Orchestrator.killChild")(function* (callerId: AgentId, childId: AgentId) {
          const child = yield* runtime(childId);
          if (child.info.parentId !== callerId) {
            return yield* notAllowed(`Agent ${childId} is not your child.`);
          }
          yield* stopRuntime(child);
        }),

        agent: (agentId) => runtime(agentId).pipe(Effect.map((rt) => rt.info)),

        notify: (agentId, text) => deliver(agentId, { _tag: "SystemNotice", text }),

        threadEvents: (threadId) => store.listThreadEvents(threadId).pipe(Effect.mapError(unavailable)),

        awaitingApproval,
      });
    }),
  ).pipe(Layer.provide(ThreadTitles.layer));
}
