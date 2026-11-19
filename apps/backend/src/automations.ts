import { Orchestrator } from "@cerium/orchestrator";
import {
  EpochMillis,
  LenientArray,
  MAX_NOTIFICATION_DETAIL,
  MAX_THREAD_TITLE,
  narrowAccess,
  ThreadId,
  type ThreadOverview,
} from "@cerium/protocol";
import {
  Automation,
  AutomationRun,
  isGitHubAutomationTrigger,
  isSchedule,
  nextSlot,
  previousSlot,
  type AutomationInput,
  type AutomationRunCause,
  type AutomationView,
  type GitHubRepository,
  PushRecord,
} from "@cerium/rpc";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from "effect";
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
import { GitHub } from "./github.ts";
import {
  GitHubAutomationEvent,
  prepareGitHubWork,
  scanGitHubEvents,
  type GitHubAutomationWork,
} from "./githubAutomationEvents.ts";
import { Git } from "./git.ts";
import { Notifications } from "./notify.ts";
import { Reviews } from "./reviews.ts";
import { SourceControl } from "./sourceControl.ts";

// The user's automations start a work thread on a schedule, a CI failure, or a GitHub event.
// They run in the backend for as long as Cerium does,
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
const GITHUB_POLL = "1 minute";
const GITHUB_OVERLAP = 2 * 60_000;
const CONFLICT_RETENTION = 30 * 24 * 60 * 60_000;

const GitHubProgress = Schema.Struct({
  since: EpochMillis,
  checkedAt: Schema.optionalKey(EpochMillis),
  repository: Schema.optionalKey(Schema.String),
  baselineConflicts: Schema.optionalKey(Schema.Boolean),
  seen: Schema.Array(GitHubAutomationEvent),
  pending: Schema.Array(GitHubAutomationEvent),
  latest: Schema.optionalKey(Schema.Array(GitHubAutomationEvent)),
});
type GitHubProgress = typeof GitHubProgress.Type;

const CompletionReview = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.String,
  startedAt: EpochMillis,
  root: Schema.String,
  base: Schema.optionalKey(Schema.String),
});

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
  github: Schema.optionalKey(GitHubProgress),
  reviews: Schema.optionalKey(Schema.Array(CompletionReview)),
});
type Stored = typeof Stored.Type;

const AutomationFile = Schema.Struct({ automations: LenientArray(Stored) });

/** What set a run off, beyond its cause. */
interface Occasion {
  readonly dueAt?: number;
  readonly push?: PushRecord;
  /** The title of the thread that pushed, for a CI trigger. */
  readonly pushedFrom?: string;
  readonly github?: GitHubAutomationWork;
  readonly reuse?: ThreadOverview;
  readonly githubEvents?: ReadonlyArray<GitHubAutomationEvent>;
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
        const github = Option.getOrUndefined(yield* Effect.serviceOption(GitHub));
        const git = Option.getOrUndefined(yield* Effect.serviceOption(Git));
        const reviews = Option.getOrUndefined(yield* Effect.serviceOption(Reviews));
        const notifications = Option.getOrUndefined(yield* Effect.serviceOption(Notifications));
        const sourceControl = Option.getOrUndefined(yield* Effect.serviceOption(SourceControl));
        const reviewing = new Set<ThreadId>();

        const entries = new Map<string, Stored>();
        const changes = yield* PubSub.unbounded<void>();
        /** One change or start at a time, so a tick and Run now never start the same time twice. */
        const permit = yield* Semaphore.make(1);

        // -------------------------------------------------------------------------------------
        // The file

        const persist = Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(AutomationFile)({ automations: [...entries.values()] });
          yield* fs.makeDirectory(path.dirname(options.file), { recursive: true });
          const scratch = `${options.file}.tmp`;
          yield* fs.writeFileString(scratch, JSON.stringify(encoded));
          yield* fs.rename(scratch, options.file);
        }).pipe(
          Effect.catch((error) => Effect.logWarning(`Couldn't save the automations: ${String(error)}`)),
        );

        const changed = Effect.andThen(persist, PubSub.publish(changes, undefined));

        const set = (entry: Stored) => Effect.sync(() => entries.set(entry.automation.id, entry));

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
              ...(occasion.github === undefined ? {} : { detail: occasion.github.detail }),
              ...(occasion.push === undefined ? {} : { detail: ciDetail(occasion.push) }),
            } satisfies Partial<AutomationRun>;
            const record = (run: AutomationRun) =>
              Effect.gen(function* () {
                const latest = entries.get(id);
                if (latest !== undefined) {
                  const events = occasion.githubEvents;
                  const github = latest.github;
                  yield* set({
                    ...latest,
                    runs: withRun(latest.runs, run),
                    ...(events === undefined || github === undefined
                      ? {}
                      : {
                          github: {
                            ...github,
                            latest: events,
                            pending: github.pending.filter(
                              (event) => !events.some((each) => each.id === event.id),
                            ),
                          },
                        }),
                  });
                }
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

            const work = occasion.github;
            const reuseLead = occasion.reuse?.agents.find((agent) => agent.parentId === undefined);
            const created =
              occasion.reuse !== undefined && reuseLead !== undefined
                ? { _tag: "Success" as const, success: { thread: occasion.reuse.thread, lead: reuseLead } }
                : yield* orchestrator
                    .createThread({
                      title: (work?.title ?? automation.name).slice(0, MAX_THREAD_TITLE),
                      mode: "work",
                      cwd: automation.project,
                      worktree: work !== undefined || automation.worktree,
                      ...(work === undefined
                        ? {}
                        : {
                            workspace: {
                              baseRef: work.base,
                              ...(work.pull === undefined ? {} : { pullRequestUrl: work.url }),
                            },
                          }),
                      ...(automation.onLimit ? { onLimit: automation.onLimit } : {}),
                      lead:
                        automation.when._tag === "PullRequestReview"
                          ? {
                              ...automation.lead,
                              access: narrowAccess(automation.lead.access, "acceptEdits"),
                            }
                          : automation.lead,
                    })
                    .pipe(Effect.result);
            if (created._tag === "Failure")
              return yield* record({ ...base, failed: created.failure.message });
            const { thread, lead } = created.success;
            // Named for when it ran, so the inbox tells one run from the next; a name differing from
            // the one it was created with also stays, not replaced by a title from the prompt.
            if (work === undefined)
              yield* orchestrator
                .renameThread(thread.id, runTitle(automation.name, at, occasion.push))
                .pipe(Effect.ignore);
            const text =
              work?.prompt ??
              (occasion.push === undefined
                ? automation.prompt
                : ciPrompt(automation.prompt, occasion.push, occasion.pushedFrom));
            const root = thread.worktree?.root ?? thread.cwd;
            if (automation.reviewOnCompletion && root !== undefined) {
              const baseCommit =
                work?.pull !== undefined && automation.when._tag === "PullRequestConflicts"
                  ? work.pull.baseCommit
                  : ((occasion.reuse === undefined ? thread.worktree?.startCommit : undefined) ??
                    (git === undefined
                      ? undefined
                      : yield* git.run(root, ["rev-parse", "--verify", "HEAD"], { look: true }).pipe(
                          Effect.map((result) => (result.code === 0 ? result.stdout.trim() : undefined)),
                          Effect.orElseSucceed(() => undefined),
                        )));
              yield* set({
                ...entry,
                reviews: [
                  ...(entry.reviews ?? []).filter((review) => review.threadId !== thread.id),
                  {
                    threadId: thread.id,
                    runId: base.id,
                    startedAt: at,
                    root,
                    ...(baseCommit ? { base: baseCommit } : {}),
                  },
                ],
              });
              yield* persist;
            }
            const sent = yield* (
              work === undefined
                ? orchestrator.sendUserMessage(lead.id, text)
                : orchestrator.wake(lead.id, text)
            ).pipe(Effect.result);
            if (sent._tag === "Failure") {
              const latest = entries.get(id);
              if (latest?.reviews !== undefined)
                yield* set({
                  ...latest,
                  reviews: latest.reviews.filter((review) => review.runId !== base.id),
                });
            }
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

        const initialGitHubProgress = (since: number): GitHubProgress => ({
          since: Math.floor(since / 1_000) * 1_000,
          seen: [],
          pending: [],
        });
        const repositoryKey = (repo: GitHubRepository) => `${repo.url}:${repo.viewer}`.toLowerCase();

        const matchingPullThreads = (automation: Automation, work: GitHubAutomationWork) =>
          Effect.gen(function* () {
            if (work.pull === undefined) return [];
            const all = yield* orchestrator.threadOverviews;
            const linked = sourceControl === undefined ? [] : yield* sourceControl.related(work.url);
            const activeLinks = new Set(linked.filter((link) => link.active).map((link) => link.id));
            const matched: Array<ThreadOverview> = [];
            for (const overview of all) {
              const { thread } = overview;
              if (
                thread.archivedAt !== undefined ||
                thread.worktree === undefined ||
                !sameFolder(automation.project, thread.worktree.project)
              )
                continue;
              if (thread.worktree.pullRequestUrl === work.url) {
                matched.push(overview);
                continue;
              }
              // A conversation can link a PR without working on its branch.
              if (git === undefined || !activeLinks.has(thread.id)) continue;
              const sameRevision = yield* git
                .run(thread.worktree.root, ["merge-base", "--is-ancestor", work.pull.head, "HEAD"], {
                  look: true,
                })
                .pipe(
                  Effect.map((answer) => answer.code === 0),
                  Effect.orElseSucceed(() => false),
                );
              if (sameRevision) matched.push(overview);
            }
            return matched;
          });

        const dispatchGitHub = Effect.fn("Automations.dispatchGitHub")(function* (
          entry: Stored,
          repo: GitHubRepository,
          events: readonly [GitHubAutomationEvent, ...GitHubAutomationEvent[]],
          manual: boolean,
        ) {
          if (github === undefined) return undefined;
          const { automation } = entry;
          const work = yield* prepareGitHubWork(github, repo, automation, events);
          if (work === undefined) {
            if (!manual && entry.github !== undefined) {
              yield* set({
                ...entry,
                github: {
                  ...entry.github,
                  pending: entry.github.pending.filter(
                    (event) => !events.some((each) => each.id === event.id),
                  ),
                },
              });
              yield* persist;
            }
            return undefined;
          }
          const related = yield* matchingPullThreads(automation, work);
          if (related.some((overview) => busy(overview) || reviewing.has(overview.thread.id)))
            return undefined;
          let reuse: ThreadOverview | undefined;
          for (const overview of related) {
            const lead = overview.agents.find((agent) => agent.parentId === undefined);
            if (
              lead === undefined ||
              lead.provider !== automation.lead.provider ||
              lead.model !== automation.lead.model
            )
              continue;
            const access =
              automation.when._tag === "PullRequestReview"
                ? narrowAccess(automation.lead.access, "acceptEdits")
                : automation.lead.access;
            if (lead.access !== access || overview.thread.cwd === undefined) continue;
            if (!(yield* fs.exists(overview.thread.cwd).pipe(Effect.orElseSucceed(() => false)))) continue;
            reuse = overview;
            break;
          }
          return yield* start(automation.id, manual ? "manual" : "trigger", {
            github: work,
            ...(!manual ? { githubEvents: events } : {}),
            ...(reuse === undefined ? {} : { reuse }),
          });
        });

        const pollGitHub = Effect.fn("Automations.pollGitHub")(function* (snapshot: Stored, now: number) {
          const { automation } = snapshot;
          if (github === undefined || automation.paused || !isGitHubAutomationTrigger(automation.when))
            return;
          const repo = yield* github.repository(automation.project);
          const repository = repositoryKey(repo);
          const saved = snapshot.github;
          const { baselineConflicts, ...progress } =
            saved?.repository !== undefined && saved.repository !== repository
              ? initialGitHubProgress(now)
              : (saved ?? initialGitHubProgress(automation.updatedAt));
          const since = Math.max(progress.since, (progress.checkedAt ?? progress.since) - GITHUB_OVERLAP);
          const found = yield* scanGitHubEvents(github, repo, automation.when, since, now);
          yield* permit.withPermits(1)(
            Effect.gen(function* () {
              const current = entries.get(automation.id);
              // An edit or pause made while GitHub was answering takes effect before its results.
              if (current?.automation !== automation) return;
              const known = new Set([...progress.seen, ...progress.pending].map((event) => event.id));
              const fresh = found
                .filter((event) => {
                  if (baselineConflicts || known.has(event.id)) return false;
                  known.add(event.id);
                  return true;
                })
                .sort((a, b) => a.at - b.at);
              const conflictIds = new Set(found.map((event) => event.id));
              const seen =
                automation.when._tag === "PullRequestConflicts"
                  ? [
                      ...progress.seen.filter(
                        (event) => !conflictIds.has(event.id) && event.at >= now - CONFLICT_RETENTION,
                      ),
                      ...found,
                    ]
                  : [...progress.seen, ...fresh].filter((event) => event.at >= now - GITHUB_OVERLAP);
              const pending = [...progress.pending, ...fresh];
              yield* set({
                ...current,
                github: {
                  ...progress,
                  repository,
                  checkedAt: now,
                  pending,
                  seen,
                },
              });
              yield* persist;
            }),
          );
          const groups = new Map<number, [GitHubAutomationEvent, ...GitHubAutomationEvent[]]>();
          for (const event of entries.get(automation.id)?.github?.pending ?? []) {
            const group = groups.get(event.number);
            if (group === undefined) groups.set(event.number, [event]);
            else group.push(event);
          }
          for (const events of groups.values()) {
            yield* permit.withPermits(1)(
              Effect.gen(function* () {
                const current = entries.get(automation.id);
                if (current?.automation !== automation) return;
                yield* dispatchGitHub(current, repo, events, false).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`GitHub automation "${automation.name}": ${error.message}`),
                  ),
                );
              }),
            );
          }
        });

        const githubTick = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.forEach(
            [...entries.values()],
            (entry) =>
              pollGitHub(entry, now).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(`Couldn't check GitHub for "${entry.automation.name}"`, cause),
                ),
              ),
            { concurrency: 3, discard: true },
          );
        });

        const clearReview = (automationId: string, runId: string) =>
          permit.withPermits(1)(
            Effect.gen(function* () {
              const latest = entries.get(automationId);
              if (latest?.reviews === undefined) return;
              yield* set({ ...latest, reviews: latest.reviews.filter((each) => each.runId !== runId) });
              yield* persist;
            }),
          );

        const reviewCompletion = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const entry = [...entries.values()].find((each) =>
              each.reviews?.some((job) => job.threadId === threadId),
            );
            const job = entry?.reviews?.find((each) => each.threadId === threadId);
            if (entry === undefined || job === undefined || reviewing.has(threadId)) return undefined;
            reviewing.add(threadId);
            return yield* Effect.gen(function* () {
              if (reviews === undefined) return "Cross-lab review is unavailable.";
              const result = yield* reviews
                .completeAutomation(threadId, job.root, job.base)
                .pipe(Effect.result);
              if (result._tag === "Failure") return `Cross-lab review: ${result.failure.message}`;
              const count = result.success.findings.length;
              return count === 0
                ? "Cross-lab review finished with no findings."
                : `Cross-lab review finished with ${count} ${count === 1 ? "finding" : "findings"}.`;
            }).pipe(
              Effect.tap(() => clearReview(entry.automation.id, job.runId)),
              Effect.ensuring(
                Effect.sync(() => {
                  reviewing.delete(threadId);
                }),
              ),
            );
          });

        /** A completed turn can outlive a quit between its last message and the review. */
        const recoverReview = (automationId: string, job: typeof CompletionReview.Type) =>
          Effect.gen(function* () {
            const overview = (yield* orchestrator.threadOverviews).find(
              (each) => each.thread.id === job.threadId,
            );
            const lead = overview?.agents.find((agent) => agent.parentId === undefined);
            if (overview === undefined || overview.thread.archivedAt !== undefined || lead === undefined) {
              yield* clearReview(automationId, job.runId);
              return;
            }
            if (busy(overview)) return;
            const history = yield* orchestrator.threadEvents(job.threadId, { withoutImages: true });
            const last = history.findLast(
              ({ agentId, at, payload }) =>
                agentId === lead.id &&
                at >= job.startedAt &&
                (payload._tag === "TurnInput" || payload._tag === "TurnCompleted"),
            );
            if (
              last?.payload._tag !== "TurnCompleted" ||
              (last.payload.stopReason !== "completed" && last.payload.stopReason !== "maxTurns")
            ) {
              yield* clearReview(automationId, job.runId);
              return;
            }
            const detail = yield* reviewCompletion(job.threadId);
            if (detail !== undefined && notifications !== undefined)
              yield* notifications.tell({
                kind: "finished",
                threadId: job.threadId,
                title: overview.thread.title.slice(0, MAX_THREAD_TITLE),
                detail: detail.slice(0, MAX_NOTIFICATION_DETAIL),
              });
          }).pipe(Effect.catch((error) => Effect.logWarning("Couldn't resume an automation review", error)));

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
        if (github !== undefined)
          yield* githubTick.pipe(
            Effect.andThen(Effect.sleep(GITHUB_POLL)),
            Effect.forever,
            Effect.delay(FIRST_LOOK),
            Effect.forkScoped,
          );
        if (notifications !== undefined)
          yield* notifications.reviewCompletionWith({
            finish: reviewCompletion,
            isRunning: (threadId) => reviewing.has(threadId),
          });
        const recoveries = [...entries.values()].flatMap(({ automation, reviews }) =>
          (reviews ?? []).map((job) => recoverReview(automation.id, job)),
        );
        if (recoveries.length > 0)
          yield* Effect.all(recoveries, { concurrency: 2, discard: true }).pipe(
            Effect.delay(FIRST_LOOK),
            Effect.forkScoped,
          );

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
                const resetGitHub = rescheduled || !sameFolder(before.automation.project, input.project);
                const githubProgress = isGitHubAutomationTrigger(input.when)
                  ? resetGitHub
                    ? initialGitHubProgress(now)
                    : before.github
                  : undefined;
                const handled =
                  rescheduled && isSchedule(input.when) ? previousSlot(input.when, now) : before?.handled;
                yield* set({
                  automation,
                  runs: before?.runs ?? [],
                  ...(handled === undefined ? {} : { handled }),
                  ...(before?.pushes === undefined ? {} : { pushes: before.pushes }),
                  ...(githubProgress === undefined ? {} : { github: githubProgress }),
                  ...(before?.reviews === undefined ? {} : { reviews: before.reviews }),
                  ...(before?.failure === undefined || !sameFolder(before.automation.project, input.project)
                    ? {}
                    : { failure: before.failure }),
                });
                yield* changed;
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
                yield* set({
                  ...entry,
                  automation: { ...automation, paused, updatedAt: now },
                  ...(handled === undefined ? {} : { handled }),
                  ...(!paused && isGitHubAutomationTrigger(automation.when)
                    ? {
                        github: {
                          ...initialGitHubProgress(now),
                          ...(automation.when._tag === "PullRequestConflicts"
                            ? { baselineConflicts: true }
                            : {}),
                        },
                      }
                    : {}),
                });
                yield* changed;
              }),
            ),

          remove: (id) =>
            permit.withPermits(1)(
              Effect.gen(function* () {
                yield* find(id);
                entries.delete(id);
                yield* changed;
              }),
            ),

          runNow: (id) =>
            permit.withPermits(1)(
              Effect.gen(function* () {
                const entry = yield* find(id);
                if (isGitHubAutomationTrigger(entry.automation.when)) {
                  const [first, ...rest] = entry.github?.latest ?? [];
                  if (first === undefined || github === undefined)
                    return yield* new AutomationError({
                      message: "This automation hasn't received a matching GitHub event yet.",
                    });
                  const repo = yield* github
                    .repository(entry.automation.project)
                    .pipe(Effect.mapError((error) => new AutomationError({ message: error.message })));
                  if (entry.github?.repository !== repositoryKey(repo))
                    return yield* new AutomationError({
                      message:
                        "The project's GitHub repository or signed-in account changed. Wait for its next matching event.",
                    });
                  const run = yield* dispatchGitHub(entry, repo, [first, ...rest], true).pipe(
                    Effect.mapError((error) => new AutomationError({ message: error.message })),
                  );
                  return (
                    run ??
                    (yield* new AutomationError({
                      message: "The GitHub item no longer matches or its pull request thread is busy.",
                    }))
                  );
                }
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
