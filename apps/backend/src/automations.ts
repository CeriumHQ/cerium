import { Orchestrator } from "@cerium/orchestrator";
import { EpochMillis, LenientArray, type ThreadOverview } from "@cerium/protocol";
import {
  Automation,
  AutomationRun,
  isSchedule,
  nextSlot,
  previousSlot,
  type AutomationInput,
  type AutomationRunCause,
  type AutomationView,
  PushRecord,
} from "@cerium/rpc";
import { Clock, Context, Effect, FileSystem, Layer, Path, PubSub, Schema, Semaphore, Stream } from "effect";
import { randomUUID } from "node:crypto";

import {
  ciDetail,
  ciPrompt,
  runTitle,
  sameFolder,
  scheduleStep,
  whenLabel,
  withRun,
} from "./automationsModel.ts";
import { Pushes } from "./pushes.ts";

// The user's automations: a prompt, a project and a model that start a work thread on a schedule
// or when CI fails on a commit an agent pushed. They run in the backend for as long as Cerium does,
// the tray included, and are kept in a file of their own beside the database.
//
// A scheduled time missed while Cerium was closed or the computer slept runs once when the
// scheduler next looks, however many were missed, while it's nearer than the next time; otherwise
// it's dropped for the next (`scheduleStep`). A scheduled run waits out a thread of the automation
// that's still working or waiting on the user, so a slow run never piles up behind itself.

/** Something the user asked of an automation that Cerium couldn't do; `message` is written for them. */
export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String,
}) {}

/** How often the scheduler looks at the clock. */
const TICK = "20 seconds";
/** How long after starting the scheduler first looks, so the harnesses have been found. */
const FIRST_LOOK = "5 seconds";
/** How many of the pushes its trigger handled an automation remembers, so a re-run's end isn't news. */
const KEPT_PUSHES = 50;

/** One automation as the file keeps it, with what the scheduler and its trigger handled. */
const Stored = Schema.Struct({
  automation: Automation,
  /** The latest scheduled time it handled. */
  handled: Schema.optionalKey(EpochMillis),
  /** Its runs, newest first. */
  runs: LenientArray(AutomationRun),
  /** The pushes its trigger handled, newest first. */
  pushes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The latest CI failure in its project, which Run now replays for a CI trigger. */
  failure: Schema.optionalKey(
    Schema.Struct({ push: PushRecord, pushedFrom: Schema.optionalKey(Schema.String) }),
  ),
});
type Stored = typeof Stored.Type;

const AutomationFile = Schema.Struct({ automations: LenientArray(Stored) });

/** What set a run off, beyond its cause. */
interface Occasion {
  readonly dueAt?: number;
  readonly push?: PushRecord;
  /** The title of the thread that pushed, for a CI trigger. */
  readonly pushedFrom?: string;
}

/** Whether a thread's agents are still at it: working, queued, or waiting on the user. */
const busy = (overview: ThreadOverview | undefined) =>
  overview !== undefined &&
  (overview.awaitingApproval ||
    overview.agents.some((agent) => agent.state === "running" || agent.state === "queued"));

export class Automations extends Context.Service<
  Automations,
  {
    /** Every automation, oldest first, now and after every change. */
    readonly watch: Stream.Stream<ReadonlyArray<AutomationView>>;
    /** Creates an automation, or with `id` replaces what the user wrote of one. */
    save(id: string | undefined, input: AutomationInput): Effect.Effect<Automation, AutomationError>;
    pause(id: string, paused: boolean): Effect.Effect<void, AutomationError>;
    remove(id: string): Effect.Effect<void, AutomationError>;
    /** Starts a run now, paused or not. */
    runNow(id: string): Effect.Effect<AutomationRun, AutomationError>;
  }
>()("cerium/backend/Automations") {
  /** Keeps the automations in `file`. Requires `Orchestrator`, `Pushes` and the platform's file system. */
  static readonly layer = (options: { readonly file: string }) =>
    Layer.effect(
      Automations,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const pushes = yield* Pushes;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const entries = new Map<string, Stored>();
        const changes = yield* PubSub.unbounded<void>();
        /** One change or start at a time, so a tick and Run now never start the same time twice. */
        const permit = yield* Semaphore.make(1);

        // -------------------------------------------------------------------------------------
        // The file

        const write = Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(AutomationFile)({ automations: [...entries.values()] });
          yield* fs.makeDirectory(path.dirname(options.file), { recursive: true });
          const scratch = `${options.file}.tmp`;
          yield* fs.writeFileString(scratch, JSON.stringify(encoded));
          yield* fs.rename(scratch, options.file);
        });

        /** Saves what runs recorded; the next change saves it again when this can't. */
        const persist = write.pipe(
          Effect.catch((error) => Effect.logWarning(`Couldn't save the automations: ${String(error)}`)),
        );

        const changed = Effect.andThen(persist, PubSub.publish(changes, undefined));

        const set = (entry: Stored) => Effect.sync(() => entries.set(entry.automation.id, entry));

        /**
         * What the user changed of one automation (`undefined` removes it), kept only once the file
         * holds it: when the file can't be written, the change is undone and the user told.
         */
        const commit = (id: string, next: Stored | undefined) =>
          Effect.gen(function* () {
            const before = entries.get(id);
            if (next === undefined) entries.delete(id);
            else entries.set(id, next);
            yield* write.pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (before === undefined) entries.delete(id);
                  else entries.set(id, before);
                  yield* Effect.logWarning(`Couldn't save the automations: ${String(error)}`);
                  return yield* new AutomationError({
                    message: "Cerium couldn't save the automations file, so nothing changed.",
                  });
                }),
              ),
            );
            yield* PubSub.publish(changes, undefined);
          });

        const find = (id: string) =>
          Effect.fromNullishOr(entries.get(id)).pipe(
            Effect.mapError(() => new AutomationError({ message: "That automation isn't there anymore." })),
          );

        const views = (now: number): ReadonlyArray<AutomationView> =>
          [...entries.values()]
            .sort((a, b) => a.automation.createdAt - b.automation.createdAt)
            .map(({ automation, runs }) => ({
              automation,
              ...(isSchedule(automation.when) && !automation.paused
                ? { nextAt: nextSlot(automation.when, now) }
                : {}),
              runs,
            }));

        // -------------------------------------------------------------------------------------
        // Runs

        const overviews = orchestrator.threadOverviews.pipe(
          Effect.orElseSucceed((): ReadonlyArray<ThreadOverview> => []),
        );

        /** Starts a thread for `entry`'s automation, or says why it didn't; never fails. */
        const start = (id: string, cause: AutomationRunCause, occasion: Occasion = {}) =>
          Effect.gen(function* () {
            const entry = entries.get(id);
            if (entry === undefined) return undefined;
            const { automation } = entry;
            const at = yield* Clock.currentTimeMillis;
            const base = {
              id: randomUUID(),
              at,
              cause,
              ...(occasion.dueAt === undefined ? {} : { dueAt: occasion.dueAt }),
              ...(occasion.push === undefined ? {} : { detail: ciDetail(occasion.push) }),
            } satisfies Partial<AutomationRun>;
            const record = (run: AutomationRun) =>
              Effect.gen(function* () {
                const latest = entries.get(id);
                if (latest !== undefined) yield* set({ ...latest, runs: withRun(latest.runs, run) });
                yield* changed;
                return run;
              });

            const last = entry.runs.find((run) => run.threadId !== undefined)?.threadId;
            if ((cause === "schedule" || cause === "missed") && last !== undefined) {
              const overview = (yield* overviews).find((each) => each.thread.id === last);
              if (busy(overview)) {
                return yield* record({
                  ...base,
                  skipped: overview?.awaitingApproval
                    ? "The last run is still waiting on you."
                    : "The last run is still working.",
                });
              }
            }
            if (!(yield* fs.exists(automation.project).pipe(Effect.orElseSucceed(() => false)))) {
              return yield* record({
                ...base,
                failed: `The project folder ${automation.project} isn't there.`,
              });
            }

            const created = yield* orchestrator
              .createThread({
                title: automation.name,
                mode: "work",
                cwd: automation.project,
                worktree: automation.worktree,
                ...(automation.onLimit ? { onLimit: automation.onLimit } : {}),
                lead: automation.lead,
              })
              .pipe(Effect.result);
            if (created._tag === "Failure")
              return yield* record({ ...base, failed: created.failure.message });
            const { thread, lead } = created.success;
            // Named for when it ran, so the inbox tells one run from the next; a name differing from
            // the one it was created with also stays, not replaced by a title from the prompt.
            yield* orchestrator
              .renameThread(thread.id, runTitle(automation.name, at, occasion.push))
              .pipe(Effect.ignore);
            const text =
              occasion.push === undefined
                ? automation.prompt
                : ciPrompt(automation.prompt, occasion.push, occasion.pushedFrom);
            const sent = yield* orchestrator.sendUserMessage(lead.id, text).pipe(Effect.result);
            return yield* record({
              ...base,
              threadId: thread.id,
              ...(sent._tag === "Failure" ? { failed: sent.failure.message } : {}),
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("An automation's run couldn't start", cause).pipe(Effect.as(undefined)),
            ),
          );

        // -------------------------------------------------------------------------------------
        // The schedule

        const tick = permit.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            for (const entry of [...entries.values()]) {
              const { automation } = entry;
              if (automation.paused || !isSchedule(automation.when)) continue;
              const handled = entry.handled ?? previousSlot(automation.when, automation.createdAt);
              const step = scheduleStep(automation.when, handled, now);
              if (step._tag === "Wait") continue;
              if (step._tag === "Drop") {
                yield* set({
                  ...entry,
                  handled: step.slot,
                  runs: withRun(entry.runs, {
                    id: randomUUID(),
                    at: now,
                    cause: "missed",
                    dueAt: step.slot,
                    skipped: `Cerium wasn't running at ${whenLabel(step.slot)}, and the next run at ${whenLabel(step.next)} is nearer.`,
                  }),
                });
                yield* changed;
                continue;
              }
              yield* set({ ...entry, handled: step.slot });
              yield* persist;
              yield* start(automation.id, step.cause, step.cause === "missed" ? { dueAt: step.slot } : {});
            }
          }),
        );

        // -------------------------------------------------------------------------------------
        // The CI trigger

        const ciFailed = (push: PushRecord) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                if (push.ci?.state !== "failed") return;
                const all = yield* overviews;
                const pushedFrom = all.find((each) => each.thread.id === push.threadId)?.thread;
                const folder = pushedFrom?.worktree?.project ?? pushedFrom?.cwd ?? push.cwd;
                const failure = {
                  push,
                  ...(pushedFrom === undefined ? {} : { pushedFrom: pushedFrom.title }),
                };
                for (const entry of [...entries.values()]) {
                  const { automation } = entry;
                  if (automation.when._tag !== "CiFailed" || !sameFolder(automation.project, folder))
                    continue;
                  if (entry.pushes?.includes(push.id)) continue;
                  // A push from one of its own runs is that run's to fix: its lead hears how CI went.
                  if (entry.runs.some((run) => run.threadId === push.threadId)) continue;
                  // Kept for Run now even while paused, which replays the latest failure.
                  yield* set({
                    ...entry,
                    failure,
                    ...(automation.paused
                      ? {}
                      : { pushes: [push.id, ...(entry.pushes ?? [])].slice(0, KEPT_PUSHES) }),
                  });
                  if (automation.paused) {
                    yield* persist;
                    continue;
                  }
                  yield* start(automation.id, "trigger", failure);
                }
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.logWarning("The CI trigger failed", cause)));

        // -------------------------------------------------------------------------------------
        // Starting up

        const saved = yield* fs.readFileString(options.file).pipe(Effect.option);
        if (saved._tag === "Some") {
          const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AutomationFile))(
            saved.value,
          ).pipe(Effect.option);
          if (decoded._tag === "Some") {
            for (const entry of decoded.value.automations) entries.set(entry.automation.id, entry);
          } else {
            // Kept aside rather than overwritten by the next save, so nothing the user wrote is lost.
            yield* fs.rename(options.file, `${options.file}.unreadable`).pipe(Effect.ignore);
            yield* Effect.logWarning(`The automations in ${options.file} couldn't be read; kept them aside.`);
          }
        }

        yield* tick.pipe(
          Effect.andThen(Effect.sleep(TICK)),
          Effect.forever,
          Effect.delay(FIRST_LOOK),
          Effect.forkScoped,
        );
        yield* pushes.ciEnded.pipe(Stream.runForEach(ciFailed), Effect.forkScoped);

        return Automations.of({
          watch: Stream.unwrap(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(changes);
              return Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)).pipe(
                Stream.mapEffect(() => Effect.map(Clock.currentTimeMillis, views)),
              );
            }),
          ),

          save: (id, input) =>
            permit.withPermits(1)(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const before = id === undefined ? undefined : yield* find(id);
                const automation: Automation = {
                  ...input,
                  name: input.name.trim(),
                  id: before?.automation.id ?? randomUUID(),
                  paused: before?.automation.paused ?? false,
                  createdAt: before?.automation.createdAt ?? now,
                  updatedAt: now,
                };
                // A new schedule starts from now: what came round before it was saved isn't missed.
                const rescheduled =
                  before === undefined ||
                  JSON.stringify(before.automation.when) !== JSON.stringify(input.when);
                const handled =
                  rescheduled && isSchedule(input.when) ? previousSlot(input.when, now) : before?.handled;
                yield* commit(automation.id, {
                  automation,
                  runs: before?.runs ?? [],
                  ...(handled === undefined ? {} : { handled }),
                  ...(before?.pushes === undefined ? {} : { pushes: before.pushes }),
                  ...(before?.failure === undefined || !sameFolder(before.automation.project, input.project)
                    ? {}
                    : { failure: before.failure }),
                });
                return automation;
              }),
            ),

          pause: (id, paused) =>
            permit.withPermits(1)(
              Effect.gen(function* () {
                const entry = yield* find(id);
                const { automation } = entry;
                if (automation.paused === paused) return;
                const now = yield* Clock.currentTimeMillis;
                // Resuming starts from now: what came round while paused is dropped, not missed.
                const handled =
                  !paused && isSchedule(automation.when) ? previousSlot(automation.when, now) : entry.handled;
                yield* commit(id, {
                  ...entry,
                  automation: { ...automation, paused, updatedAt: now },
                  ...(handled === undefined ? {} : { handled }),
                });
              }),
            ),

          remove: (id) =>
            permit.withPermits(1)(
              Effect.gen(function* () {
                yield* find(id);
                yield* commit(id, undefined);
              }),
            ),

          runNow: (id) =>
            permit.withPermits(1)(
              Effect.gen(function* () {
                const entry = yield* find(id);
                // A CI trigger's Run now looks at the latest failure in its project, when there's been one.
                const failure = entry.automation.when._tag === "CiFailed" ? entry.failure : undefined;
                const run = yield* start(id, "manual", failure ?? {});
                return run === undefined
                  ? yield* new AutomationError({ message: "The run couldn't start; Cerium's log says why." })
                  : run;
              }),
            ),
        });
      }),
    );
}
