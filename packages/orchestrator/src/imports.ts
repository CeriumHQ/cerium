import type { PastHistory, PastSession as HarnessSession } from "@cerium/harness";
import {
  LEAD_ROLE,
  MAX_THREAD_TITLE,
  type AccessMode,
  type AgentEvent,
  type AgentId,
  type AgentInfo,
  type EventId,
  type EventPayload,
  type PastSession,
  type ProviderId,
  type ThreadId,
  type ThreadInfo,
} from "@cerium/protocol";
import { Store, type StoreError } from "@cerium/store";
import { Clock, Context, Crypto, Duration, Effect, FileSystem, Layer, Path, Semaphore } from "effect";
import { tmpdir } from "node:os";

import { OrchestratorError } from "./errors.ts";
import { Adapters, Catalog, OrchestratorConfig } from "./services.ts";

// Bringing the user's own harness sessions into Cerium: each becomes a thread whose lead is stopped on
// that session, so the user's next message resumes it in place, with its history translated before it.

/** How the user chose to bring sessions in. */
export interface ImportOptions {
  /** The access the leads of work threads get; chats stay read-only. */
  readonly access: AccessMode;
  /** Sessions last active before this go straight to Archive. */
  readonly archiveBefore?: number;
}

/** How long reading one session's history may take before it comes in without it. */
const READ_TIMEOUT = Duration.minutes(2);
/** Histories read at once: most harnesses start a process to read one. */
const READ_CONCURRENCY = 4;

/** What an imported history keeps of an adapter's events: the conversation and its work. */
const HISTORY_TAGS: ReadonlySet<EventPayload["_tag"]> = new Set([
  "MessageCompleted",
  "ReasoningCompleted",
  "ToolCallStarted",
  "ToolCallCompleted",
  "FileChanged",
  "TodosUpdated",
  "AgentError",
  "TurnCompleted",
]);

const sessionKey = (provider: ProviderId, id: string) => `${provider}:${id}`;

/** A session as its adapter knows it, without the harness Cerium lists it under. */
const toHarnessSession = ({ provider: _provider, ...session }: PastSession): HarnessSession => session;

/** A session's history as its harness gave it, or why it gave none. */
export type ImportedHistory = PastHistory | { readonly unavailable: string };

/**
 * A lead's events for an imported session, each with when it happened: the import, the session's
 * start, then each turn's prompt and reply. A turn left with tool calls open closes them, and each
 * turn ends. Turns without a time are spread over the session's life.
 */
export const importedEvents = (
  session: PastSession,
  model: string,
  history: ImportedHistory,
  messageId: (turn: number) => string,
): ReadonlyArray<{ readonly at: number; readonly payload: EventPayload }> => {
  const start = Math.min(session.createdAt ?? session.updatedAt, session.updatedAt);
  const end = session.updatedAt;
  const events: Array<{ at: number; payload: EventPayload }> = [
    {
      at: start,
      payload:
        "unavailable" in history
          ? {
              _tag: "SessionImported",
              provider: session.provider,
              history: "unavailable",
              detail: history.unavailable,
            }
          : { _tag: "SessionImported", provider: session.provider, history: "full" },
    },
    {
      at: start,
      payload: { _tag: "SessionStarted", provider: session.provider, providerSessionId: session.id, model },
    },
  ];
  if ("unavailable" in history) return events;
  let last = start;
  const { turns } = history;
  for (const [index, turn] of turns.entries()) {
    const spread = start + ((end - start) * index) / Math.max(1, turns.length);
    last = Math.max(last, Math.min(end, Math.round(turn.at ?? spread)));
    const at = last;
    events.push({
      at,
      payload: { _tag: "TurnInput", items: [{ _tag: "FromUser", id: messageId(index), text: turn.prompt }] },
    });
    const open = new Set<string>();
    const closeOpen = () => {
      for (const callId of open) {
        events.push({
          at,
          payload: { _tag: "ToolCallCompleted", callId, output: "No result was recorded.", isError: true },
        });
      }
      open.clear();
    };
    let ended = false;
    for (const { payload } of turn.events) {
      if (!HISTORY_TAGS.has(payload._tag) || ended) continue;
      if (payload._tag === "ToolCallStarted") open.add(payload.callId);
      if (payload._tag === "ToolCallCompleted") open.delete(payload.callId);
      if (payload._tag === "TurnCompleted") {
        closeOpen();
        ended = true;
      }
      events.push({ at, payload });
    }
    if (!ended) {
      closeOpen();
      events.push({ at, payload: { _tag: "TurnCompleted", stopReason: "completed" } });
    }
  }
  return events;
};

/** Whether `folder` is `root` or inside it, ignoring case where the platform does. */
const isWithin = (path: Path.Path, root: string, folder: string) => {
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const relative = path.relative(fold(path.resolve(root)), fold(path.resolve(folder)));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const unavailable = (error: StoreError) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

export class SessionImports extends Context.Service<
  SessionImports,
  {
    /**
     * The user's sessions with each signed-in harness that lists them, newest first, less those a
     * thread already holds, those in a temporary folder or Cerium's own, and those whose folder is gone.
     */
    readonly list: Effect.Effect<ReadonlyArray<PastSession>, OrchestratorError>;
    /**
     * Brings sessions in as threads, each with its lead stopped on the session and its history before
     * it, and resolves with the threads made. A session a thread already holds is skipped, so bringing
     * one in twice makes one thread.
     */
    importSessions(
      sessions: ReadonlyArray<PastSession>,
      options: ImportOptions,
    ): Effect.Effect<ReadonlyArray<ThreadInfo>, OrchestratorError>;
  }
>()("cerium/orchestrator/SessionImports") {
  static readonly layer = Layer.effect(
    SessionImports,
    Effect.gen(function* () {
      const store = yield* Store;
      const adapters = yield* Adapters;
      const catalog = yield* Catalog;
      const config = yield* OrchestratorConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      // One import at a time, so two can't both bring in the same session.
      const lock = yield* Semaphore.make(1);

      const makeId = (prefix: string) =>
        crypto.randomUUIDv7().pipe(
          Effect.map((uuid) => `${prefix}_${uuid}`),
          Effect.orDie,
        );

      /** The sessions threads already hold, by harness and id. */
      const heldSessions = store.listAllAgents.pipe(
        Effect.map(
          (agents) =>
            new Set(
              agents.flatMap((agent) =>
                agent.providerSessionId === undefined
                  ? []
                  : [sessionKey(agent.provider, agent.providerSessionId)],
              ),
            ),
        ),
        Effect.mapError(unavailable),
      );

      /** Folders whose sessions are Cerium's own or throwaway: its probes, completions and chats. */
      const ownFolders = [
        tmpdir(),
        config.chatDirectory,
        ...(config.titleDirectory ? [config.titleDirectory] : []),
      ];

      const folderExists = (folder: string) => fs.exists(folder).pipe(Effect.orElseSucceed(() => false));

      const list = Effect.gen(function* () {
        const held = yield* heldSessions;
        const listed = yield* Effect.forEach(
          [...adapters.values()],
          (adapter) =>
            adapter.listSessions === undefined
              ? Effect.succeed([])
              : adapter.listSessions.pipe(
                  Effect.map((sessions) =>
                    sessions.map((session): PastSession => ({ provider: adapter.provider, ...session })),
                  ),
                  // A harness that isn't installed or signed in has nothing to offer; one that fails
                  // leaves the others' sessions.
                  Effect.catch((error) =>
                    error._tag === "HarnessUnavailable"
                      ? Effect.succeed([])
                      : Effect.logWarning(`Couldn't list ${adapter.provider} sessions`, error).pipe(
                          Effect.as([]),
                        ),
                  ),
                ),
          { concurrency: "unbounded" },
        );
        const candidates = listed
          .flat()
          .filter(
            (session) =>
              !held.has(sessionKey(session.provider, session.id)) &&
              (session.cwd === undefined || !ownFolders.some((root) => isWithin(path, root, session.cwd!))),
          );
        const present = yield* Effect.forEach(
          candidates,
          (session) => (session.cwd === undefined ? Effect.succeed(true) : folderExists(session.cwd)),
          { concurrency: 16 },
        );
        return candidates
          .filter((_, index) => present[index])
          .toSorted((left, right) => right.updatedAt - left.updatedAt);
      }).pipe(Effect.withSpan("SessionImports.list"));

      /** The model a session's lead runs on: the one it last ran on, else the harness's default. */
      const leadModel = (session: PastSession, history: PastHistory | undefined) =>
        Effect.gen(function* () {
          const recorded = history?.model ?? session.model;
          if (recorded !== undefined) return recorded;
          const models = catalog.models === undefined ? [] : yield* catalog.models;
          const offered = models.filter((model) => model.provider === session.provider);
          const fallback =
            offered.find((model) => model.isDefault === true)?.id ??
            offered[0]?.id ??
            (yield* catalog.entries).find((entry) => entry.provider === session.provider)?.model;
          if (fallback === undefined) {
            return yield* new OrchestratorError({
              reason: "unavailable",
              message: `No ${session.provider} model is available to go on with this session.`,
            });
          }
          return fallback;
        });

      /** What the harness gives of a session's history, or why it gives none. */
      const readHistory = (session: PastSession): Effect.Effect<ImportedHistory> => {
        const adapter = adapters.get(session.provider);
        if (adapter?.readSession === undefined) {
          return Effect.succeed({ unavailable: "This harness doesn't give a session's history." });
        }
        return adapter.readSession(toHarnessSession(session)).pipe(
          Effect.timeoutOrElse({
            duration: READ_TIMEOUT,
            orElse: () => Effect.succeed({ unavailable: "Reading the history took too long." }),
          }),
          Effect.catch((error) =>
            Effect.logWarning(`Couldn't read ${session.provider} session ${session.id}`, error).pipe(
              Effect.as({ unavailable: error.message }),
            ),
          ),
        );
      };

      const importOne = Effect.fn("SessionImports.importOne")(function* (
        session: PastSession,
        history: ImportedHistory,
        options: ImportOptions,
      ) {
        const model = yield* leadModel(session, "unavailable" in history ? undefined : history);
        const now = yield* Clock.currentTimeMillis;
        const threadId = (yield* makeId("thr")) as ThreadId;
        const work = session.cwd !== undefined && (yield* folderExists(session.cwd));
        const createdAt = Math.min(session.createdAt ?? session.updatedAt, session.updatedAt);
        const title = session.title.replace(/\s+/g, " ").trim();
        const thread: ThreadInfo = {
          id: threadId,
          title: title.length > MAX_THREAD_TITLE ? `${title.slice(0, MAX_THREAD_TITLE - 1)}…` : title,
          mode: work ? "work" : "chat",
          ...(work ? { cwd: session.cwd } : {}),
          createdAt,
          updatedAt: session.updatedAt,
          ...(options.archiveBefore !== undefined && session.updatedAt < options.archiveBefore
            ? { archivedAt: now }
            : {}),
        };
        if (!work) {
          yield* fs
            .makeDirectory(path.join(config.chatDirectory, threadId), { recursive: true })
            .pipe(
              Effect.mapError(
                (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
              ),
            );
        }
        const lead: AgentInfo = {
          id: (yield* makeId("agt")) as AgentId,
          threadId,
          role: LEAD_ROLE,
          provider: session.provider,
          model,
          access: work ? options.access : "readOnly",
          state: "stopped",
          providerSessionId: session.id,
          createdAt,
          updatedAt: session.updatedAt,
        };
        const messageIds = yield* Effect.forEach("unavailable" in history ? [] : history.turns, () =>
          makeId("msg"),
        );
        const events = importedEvents(session, model, history, (turn) => messageIds[turn]!).map(
          ({ at, payload }, sequence): AgentEvent => ({
            id: `${lead.id}:${sequence}` as EventId,
            threadId,
            agentId: lead.id,
            sequence,
            at,
            payload,
          }),
        );
        yield* Effect.gen(function* () {
          yield* store.createThread(thread);
          yield* store.createAgent(lead);
          yield* store.appendEvents(events);
        }).pipe(
          Effect.mapError(unavailable),
          // A thread whose history didn't all go in would look like a session that lost its start.
          Effect.onError(() => store.deleteThread(threadId).pipe(Effect.ignore)),
        );
        return thread;
      });

      const importSessions = Effect.fn("SessionImports.importSessions")(function* (
        sessions: ReadonlyArray<PastSession>,
        options: ImportOptions,
      ) {
        const held = yield* heldSessions;
        const fresh = sessions.filter((session, index) => {
          const key = sessionKey(session.provider, session.id);
          return (
            !held.has(key) &&
            adapters.has(session.provider) &&
            sessions.findIndex((other) => sessionKey(other.provider, other.id) === key) === index
          );
        });
        const threads = yield* Effect.forEach(
          fresh,
          (session) =>
            readHistory(session).pipe(
              Effect.flatMap((history) => importOne(session, history, options)),
              Effect.map((thread) => [thread]),
              // One session that can't come in leaves the others.
              Effect.catch((error) =>
                Effect.logWarning(`Couldn't import ${session.provider} session ${session.id}`, error).pipe(
                  Effect.as([]),
                ),
              ),
            ),
          { concurrency: READ_CONCURRENCY },
        );
        return threads.flat();
      }, lock.withPermits(1));

      return SessionImports.of({ list, importSessions });
    }),
  );
}
