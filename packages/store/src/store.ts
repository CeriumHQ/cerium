import { AgentEvent, AgentInfo, ThreadInfo, type AgentId, type ThreadId } from "@cerium/protocol";
import { and, asc, eq, gt, max } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";

import { openDatabase } from "./database.ts";
import { agents, events, threads } from "./schema.ts";

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export type AgentPatch = Partial<Pick<AgentInfo, "state" | "model" | "effort" | "providerSessionId">> & {
  readonly updatedAt: number;
};

export class Store extends Context.Service<
  Store,
  {
    createThread(thread: ThreadInfo): Effect.Effect<void, StoreError>;
    getThread(id: ThreadId): Effect.Effect<Option.Option<ThreadInfo>, StoreError>;
    readonly listThreads: Effect.Effect<ReadonlyArray<ThreadInfo>, StoreError>;
    createAgent(agent: AgentInfo): Effect.Effect<void, StoreError>;
    updateAgent(id: AgentId, patch: AgentPatch): Effect.Effect<void, StoreError>;
    getAgent(id: AgentId): Effect.Effect<Option.Option<AgentInfo>, StoreError>;
    listAgents(threadId: ThreadId): Effect.Effect<ReadonlyArray<AgentInfo>, StoreError>;
    /** Appends atomically: either every event is stored or none is. */
    appendEvents(batch: ReadonlyArray<AgentEvent>): Effect.Effect<void, StoreError>;
    listEvents(
      agentId: AgentId,
      options?: { readonly afterSequence?: number },
    ): Effect.Effect<ReadonlyArray<AgentEvent>, StoreError>;
    /** The highest stored sequence for an agent, so a restarted agent continues after it. */
    lastSequence(agentId: AgentId): Effect.Effect<Option.Option<number>, StoreError>;
  }
>()("cerium/store/Store") {
  static layer(options: { readonly filename: string; readonly migrationsFolder: string }) {
    return Layer.effect(
      Store,
      Effect.gen(function* () {
        const { db, runMigrations } = yield* Effect.acquireRelease(
          Effect.try({
            try: () => openDatabase(options.filename),
            catch: (cause) => new StoreError({ message: `Could not open ${options.filename}`, cause }),
          }),
          (database) => Effect.sync(database.close),
        );
        yield* Effect.tryPromise({
          try: () => runMigrations(options.migrationsFolder),
          catch: (cause) => new StoreError({ message: "Could not migrate the database", cause }),
        });

        // One connection, one operation at a time (see openDatabase).
        const lock = yield* Semaphore.make(1);
        const query = <A>(message: string, run: () => Promise<A>) =>
          lock.withPermits(1)(
            Effect.tryPromise({ try: run, catch: (cause) => new StoreError({ message, cause }) }),
          );
        const decode =
          <S extends Schema.Top>(schema: S, message: string) =>
          (row: unknown) =>
            Schema.decodeUnknownEffect(schema)(withoutNulls(row)).pipe(
              Effect.mapError((cause) => new StoreError({ message, cause })),
            );
        const decodeThread = decode(ThreadInfo, "Stored thread is invalid");
        const decodeAgent = decode(AgentInfo, "Stored agent is invalid");
        const decodeEvent = decode(AgentEvent, "Stored event is invalid");

        return Store.of({
          createThread: (thread) =>
            query("Could not create the thread", () =>
              db.insert(threads).values({
                ...thread,
                cwd: thread.cwd ?? null,
                archivedAt: thread.archivedAt ?? null,
              }),
            ),
          getThread: (id) =>
            query("Could not read the thread", () =>
              db.select().from(threads).where(eq(threads.id, id)),
            ).pipe(
              Effect.flatMap((rows) => Effect.forEach(rows, decodeThread)),
              Effect.map((rows) => Option.fromNullishOr(rows[0])),
            ),
          listThreads: query("Could not list threads", () =>
            db.select().from(threads).orderBy(asc(threads.createdAt)),
          ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeThread))),
          createAgent: (agent) =>
            query("Could not create the agent", () =>
              db.insert(agents).values({
                ...agent,
                parentId: agent.parentId ?? null,
                effort: agent.effort ?? null,
                providerSessionId: agent.providerSessionId ?? null,
              }),
            ),
          updateAgent: (id, patch) =>
            query("Could not update the agent", () => db.update(agents).set(patch).where(eq(agents.id, id))),
          getAgent: (id) =>
            query("Could not read the agent", () => db.select().from(agents).where(eq(agents.id, id))).pipe(
              Effect.flatMap((rows) => Effect.forEach(rows, decodeAgent)),
              Effect.map((rows) => Option.fromNullishOr(rows[0])),
            ),
          listAgents: (threadId) =>
            query("Could not list agents", () =>
              db.select().from(agents).where(eq(agents.threadId, threadId)).orderBy(asc(agents.createdAt)),
            ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeAgent))),
          appendEvents: (batch) => {
            const [first, ...rest] = batch.map((event) =>
              db.insert(events).values({
                id: event.id,
                threadId: event.threadId,
                agentId: event.agentId,
                sequence: event.sequence,
                at: event.at,
                tag: event.payload._tag,
                payload: event.payload,
                raw: event.raw ?? null,
              }),
            );
            return first === undefined
              ? Effect.void
              : query("Could not append events", () => db.batch([first, ...rest]));
          },
          listEvents: (agentId, options) =>
            query("Could not list events", () =>
              db
                .select()
                .from(events)
                .where(
                  and(
                    eq(events.agentId, agentId),
                    options?.afterSequence === undefined
                      ? undefined
                      : gt(events.sequence, options.afterSequence),
                  ),
                )
                .orderBy(asc(events.sequence)),
            ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeEvent))),
          lastSequence: (agentId) =>
            query("Could not read the last sequence", () =>
              db
                .select({ last: max(events.sequence) })
                .from(events)
                .where(eq(events.agentId, agentId)),
            ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.last))),
        });
      }),
    );
  }
}

/** SQL NULL columns map to absent optional keys in the protocol schemas. */
const withoutNulls = (row: unknown): unknown =>
  typeof row === "object" && row !== null
    ? Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))
    : row;
