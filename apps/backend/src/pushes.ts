import { PushHost, type PushAnswer, type PushRequest } from "@cerium/bus";
import { Orchestrator, OrchestratorError } from "@cerium/orchestrator";
import { LenientArray, MAX_THREAD_TITLE, type AgentId, type ThreadId } from "@cerium/protocol";
import {
  PushRecord,
  type CheckFailure,
  type PushAction,
  type PushCheck,
  type PushCi,
  type PushRun,
} from "@cerium/rpc";
import {
  Context,
  Deferred,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomUUID } from "node:crypto";

import { GitHub, isGitHubHost, parseRemoteUrl, type RemoteRepository } from "./github.ts";
import { Notifications } from "./notify.ts";
import {
  ciHeadline,
  ciNote,
  checksOf,
  failureNote,
  finishHook,
  finished,
  isStepEnd,
  logTail,
  NO_PROGRESS,
  outcomeNote,
  pushOutcome,
  readLine,
  rollup,
  runsOf,
  SIMULATED_FAILURE_LOG,
  simulatedCi,
  tailOf,
  type PushProgress,
} from "./pushModel.ts";

// Pushes agents make with the bus's `push` tool. Each runs the user's own `git push`, pre-push hook
// and all, and is then followed on GitHub through the user's `gh` until its CI runs finish: the
// thread shows it all, and the agent hears how CI went. Records are kept in a file, so a watch
// outlives a restart of the app.

/** A push the user asked about that Cerium couldn't do; `message` is written for the user. */
export class PushError extends Schema.TaggedError<PushError>()("PushError", {
  message: Schema.String,
}) {}

/** How long the tool waits for the push before answering `checking`, inside every harness's MCP timeout (Codex: 60s). */
const ANSWER_WITHIN = "45 seconds";
/** How long a push, its hook included, may take. */
const PUSH_TIMEOUT = "30 minutes";
/** How long a push waits for GitHub to start its runs before it says there are none. */
const RUNS_APPEAR_WITHIN = 120_000;
/** How long a push's CI is followed. */
const FOLLOW_FOR = 6 * 60 * 60_000;
/** GitHub failures in a row before the watch gives up. */
const MAX_POLL_FAILURES = 10;
/** Pushes the file keeps, newest last. */
const KEPT = 300;
/** What a push record keeps of the output. */
const OUTPUT_LIMIT = 24_000;
/** How often the thread sees a push's output as it comes. */
const PUBLISH_EVERY = "250 millis";

/**
 * Where a push's checks come from: a GitHub repository, or a simulation a repository asks for with
 * `git config cerium.simulatedCi pass|fail`, to see the checks without pushing anywhere real.
 */
type Target =
  | { readonly _tag: "GitHub"; readonly repository: RemoteRepository }
  | { readonly _tag: "Simulated"; readonly outcome: "pass" | "fail" };

const PushFile = Schema.Struct({ pushes: LenientArray(PushRecord) });

export class Pushes extends Context.Service<
  Pushes,
  {
    /** A thread's pushes, oldest first, now and after every change. */
    watch(threadId: ThreadId): Stream.Stream<ReadonlyArray<PushRecord>>;
    act(pushId: string, action: PushAction): Effect.Effect<void, PushError>;
    push(agentId: AgentId, request: PushRequest): Effect.Effect<PushAnswer, PushError | OrchestratorError>;
    /** Each push whose CI finished, as it finishes, from when it's subscribed to. */
    readonly ciEnded: Stream.Stream<PushRecord>;
  }
>()("cerium/backend/Pushes") {
  /**
   * Keeps its records in `file`, and provides the bus's `PushHost` too. Requires `Orchestrator`,
   * `GitHub`, `Notifications` and the platform's file system and processes.
   */
  static readonly layer = (options: { readonly file: string }) => {
    const pushes = Layer.effect(
      Pushes,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const github = yield* GitHub;
        const notifications = yield* Notifications;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const records = new Map<string, PushRecord>();
        const changes = yield* PubSub.unbounded<ThreadId>();
        const ciEnded = yield* PubSub.unbounded<PushRecord>();
        /** Agents with a push under way. */
        const pushing = new Set<AgentId>();
        /** Pushes whose runs the user cancelled from the thread, which end `cancelled`, not `superseded`. */
        const cancelled = new Set<string>();
        /** When each simulated CI started, and its attempt. */
        const simulated = new Map<string, { readonly startedAt: number; readonly attempt: number }>();

        const runners = yield* FiberMap.make<string>();
        const watchers = yield* FiberMap.make<string>();
        const publishing = yield* FiberMap.make<string>();

        // -------------------------------------------------------------------------------------
        // Records

        const persist = Effect.gen(function* () {
          const kept = [...records.values()].slice(-KEPT);
          const encoded = yield* Schema.encodeEffect(PushFile)({ pushes: kept });
          yield* fs.makeDirectory(path.dirname(options.file), { recursive: true });
          const scratch = `${options.file}.tmp`;
          yield* fs.writeFileString(scratch, JSON.stringify(encoded));
          yield* fs.rename(scratch, options.file);
        }).pipe(Effect.catch((error) => Effect.logWarning(`Couldn't save the pushes: ${String(error)}`)));

        const publish = (push: PushRecord) =>
          Effect.gen(function* () {
            yield* PubSub.publish(changes, push.threadId);
            yield* FiberMap.run(publishing, "file", persist.pipe(Effect.delay("1 second")), {
              onlyIfMissing: true,
            });
          });

        /** Changes a push and tells its thread, now or, with `soon`, within `PUBLISH_EVERY`. */
        const update = (id: string, change: (push: PushRecord) => PushRecord, soon = false) =>
          Effect.gen(function* () {
            const current = records.get(id);
            if (current === undefined) return undefined;
            const next = { ...change(current), updatedAt: Date.now() };
            records.set(id, next);
            if (soon) {
              yield* FiberMap.run(
                publishing,
                id,
                Effect.suspend(() => publish(records.get(id) ?? next)).pipe(Effect.delay(PUBLISH_EVERY)),
                { onlyIfMissing: true },
              );
            } else {
              yield* publish(next);
            }
            return next;
          });

        const ofThread = (threadId: ThreadId) =>
          [...records.values()]
            .filter((push) => push.threadId === threadId)
            .sort((a, b) => a.createdAt - b.createdAt);

        const find = (pushId: string) =>
          Effect.fromNullishOr(records.get(pushId)).pipe(
            Effect.mapError(() => new PushError({ message: "That push isn't known anymore." })),
          );

        // -------------------------------------------------------------------------------------
        // Git

        const git = (cwd: string, args: ReadonlyArray<string>) =>
          github.git(cwd, args).pipe(Effect.mapError((error) => new PushError({ message: error.message })));

        const line = (cwd: string, args: ReadonlyArray<string>) =>
          git(cwd, args).pipe(Effect.map((result) => (result.code === 0 ? result.stdout.trim() : undefined)));

        /** The remote and branch a request means, and the branch's upstream there, if it has one. */
        const resolve = Effect.fn("Pushes.resolve")(function* (cwd: string, request: PushRequest) {
          const branch = request.branch ?? (yield* line(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
          if (branch === undefined || branch === "") {
            return yield* new PushError({
              message: "No branch is checked out here: name the branch to push.",
            });
          }
          if ((yield* line(cwd, ["check-ref-format", "--branch", branch])) === undefined) {
            return yield* new PushError({ message: `${branch} isn't a branch name git accepts.` });
          }
          if (
            (yield* line(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) === undefined
          ) {
            return yield* new PushError({ message: `There's no local branch ${branch}.` });
          }
          const remotes = ((yield* line(cwd, ["remote"])) ?? "").split("\n").filter((name) => name !== "");
          const upstreamRemote = yield* line(cwd, ["config", "--get", `branch.${branch}.remote`]);
          const upstreamMerge = yield* line(cwd, ["config", "--get", `branch.${branch}.merge`]);
          const remote =
            request.remote ??
            (upstreamRemote !== undefined && remotes.includes(upstreamRemote)
              ? upstreamRemote
              : remotes.includes("origin")
                ? "origin"
                : remotes.length === 1
                  ? remotes[0]
                  : undefined);
          if (remote === undefined) {
            return yield* new PushError({
              message:
                remotes.length === 0
                  ? "This repository has no remote to push to."
                  : `Name the remote to push to: ${remotes.join(", ")}.`,
            });
          }
          if (!remotes.includes(remote)) {
            return yield* new PushError({ message: `There's no remote named ${remote}.` });
          }
          const tracked = remote === upstreamRemote && upstreamMerge?.startsWith("refs/heads/") === true;
          return {
            branch,
            remote,
            remoteBranch: tracked ? upstreamMerge.slice("refs/heads/".length) : branch,
            upstream: upstreamRemote !== undefined,
          };
        });

        /** What `branch` has that the remote doesn't yet, newest first. */
        const unpushed = (cwd: string, branch: string, remote: string, remoteBranch: string) =>
          Effect.gen(function* () {
            const base = yield* line(cwd, [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/remotes/${remote}/${remoteBranch}`,
            ]);
            const range =
              base === undefined
                ? [`refs/heads/${branch}`, "--not", `--remotes=${remote}`]
                : [`${base}..refs/heads/${branch}`];
            const listed = (yield* line(cwd, ["log", "--format=%H%x1f%s", "-n", "100", ...range])) ?? "";
            return listed
              .split("\n")
              .filter((each) => each !== "")
              .map((each) => {
                const [sha = "", subject = ""] = each.split("\x1f");
                return { sha, subject };
              });
          });

        /** Runs `git push` for a recorded push, its output into the record as it comes. */
        const send = (id: string, args: ReadonlyArray<string>, cwd: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("git", [...args], {
                  cwd,
                  env: { GIT_TERMINAL_PROMPT: "0" },
                  extendEnv: true,
                  stdin: "ignore",
                }),
              );
              let progress: PushProgress = NO_PROGRESS;
              let output = "";
              const lines = (stream: Stream.Stream<Uint8Array, unknown>) =>
                stream.pipe(Stream.decodeText, Stream.splitLines);
              yield* Stream.merge(lines(handle.stdout), lines(handle.stderr)).pipe(
                Stream.runForEach((text) => {
                  const before = progress;
                  progress = readLine(progress, text, Date.now());
                  // A step's result is said by its row; its marker line is only for the reader above.
                  if (!isStepEnd(text)) output = tailOf(`${output}${text}\n`, OUTPUT_LIMIT);
                  const moved = progress !== before;
                  return update(
                    id,
                    (push) => ({
                      ...push,
                      output,
                      hook: progress.hook,
                      stage: progress.sending ? "pushing" : push.stage,
                    }),
                    !moved,
                  );
                }),
              );
              const code = Number(yield* handle.exitCode);
              return { code, output, progress };
            }),
          );

        // -------------------------------------------------------------------------------------
        // CI

        const targetOf = (cwd: string, remote: string) =>
          Effect.gen(function* () {
            const outcome = yield* line(cwd, ["config", "--get", "cerium.simulatedCi"]);
            if (outcome === "pass" || outcome === "fail")
              return { _tag: "Simulated", outcome } satisfies Target;
            const url = yield* line(cwd, ["remote", "get-url", remote]);
            const repository = url === undefined ? undefined : parseRemoteUrl(url);
            if (repository === undefined || !isGitHubHost(repository.host)) return undefined;
            return { _tag: "GitHub", repository } satisfies Target;
          }).pipe(Effect.orElseSucceed(() => undefined));

        const rest = (target: Extract<Target, { _tag: "GitHub" }>, method: "GET" | "POST", route: string) =>
          github
            .rest(
              target.repository.host,
              method,
              `repos/${target.repository.owner}/${target.repository.name}/${route}`,
            )
            .pipe(Effect.mapError((error) => new PushError({ message: error.message })));

        /** The runs and checks the pushed commit has now. */
        const poll = (push: PushRecord, target: Target) =>
          Effect.gen(function* () {
            if (target._tag === "Simulated") {
              const started = simulated.get(push.id) ?? { startedAt: Date.now(), attempt: 1 };
              simulated.set(push.id, started);
              const outcome = started.attempt > 1 ? "pass" : target.outcome;
              return simulatedCi(Date.now() - started.startedAt, outcome, started.startedAt, started.attempt);
            }
            const listed = runsOf(
              yield* rest(target, "GET", `actions/runs?head_sha=${push.head}&per_page=50`),
            );
            const known = push.ci?.checks ?? [];
            const runs: Array<PushRun> = [];
            const checks: Array<PushCheck> = [];
            for (const run of listed) {
              const before = push.ci?.runs.find((each) => each.id === run.id);
              const kept = known.filter((check) => check.runId === run.id);
              const settled =
                before !== undefined &&
                before.attempt === run.attempt &&
                finished(before.state) &&
                finished(run.state);
              const jobs = settled
                ? kept
                : checksOf(run.id, yield* rest(target, "GET", `actions/runs/${run.id}/jobs?per_page=100`));
              runs.push({
                id: run.id,
                name: run.name,
                ...(run.number === undefined ? {} : { number: run.number }),
                attempt: run.attempt,
                url: run.url,
                state: run.state,
              });
              checks.push(...jobs);
            }
            return { runs, checks };
          });

        /** A failed check's log, cut to its end. */
        const failureOf = (check: PushCheck, target: Target) =>
          Effect.gen(function* () {
            const raw =
              target._tag === "Simulated"
                ? SIMULATED_FAILURE_LOG
                : yield* rest(target, "GET", `actions/jobs/${check.id}/logs`).pipe(
                    Effect.map((answer) => (typeof answer === "string" ? answer : "")),
                    Effect.orElseSucceed(() => ""),
                  );
            const { log, summary } = logTail(raw);
            return {
              checkId: check.id,
              name: check.name,
              ...(check.failedStep === undefined ? {} : { step: check.failedStep }),
              ...(summary === undefined ? {} : { summary }),
              log,
              ...(check.url === undefined ? {} : { url: check.url }),
            } satisfies CheckFailure;
          });

        /** Whether a newer run of the same workflow on the branch cancelled this push's. */
        const superseded = (push: PushRecord, target: Target) =>
          Effect.gen(function* () {
            if (target._tag === "Simulated") return false;
            const mine = runsOf(yield* rest(target, "GET", `actions/runs?head_sha=${push.head}&per_page=50`));
            const branch = runsOf(
              yield* rest(
                target,
                "GET",
                `actions/runs?branch=${encodeURIComponent(push.branch)}&per_page=30`,
              ),
            );
            return mine.some(
              (run) =>
                run.state === "cancelled" &&
                branch.some(
                  (other) =>
                    other.workflowId === run.workflowId &&
                    other.id !== run.id &&
                    (other.createdAt ?? 0) > (run.createdAt ?? 0),
                ),
            );
          }).pipe(Effect.orElseSucceed(() => false));

        const setCi = (id: string, ci: PushCi) => update(id, (push) => ({ ...push, ci }));

        /** Tells the agent and the user's window how CI ended. */
        const tellEnd = (push: PushRecord) =>
          Effect.gen(function* () {
            const note = ciNote(push);
            // A red run is the agent's to fix, so it's picked back up for it; other news waits for it.
            if (note !== undefined && push.ci?.state === "failed") {
              yield* orchestrator.wake(push.agentId, note).pipe(Effect.ignore);
            } else if (note !== undefined) {
              yield* orchestrator.notify(push.agentId, note);
            }
            const headline = ciHeadline(push);
            if (headline === undefined) return;
            const thread = (yield* orchestrator.listThreads).find((each) => each.id === push.threadId);
            yield* notifications.tell({
              threadId: push.threadId,
              kind: push.ci?.state === "passed" ? "finished" : "failed",
              title: (thread?.title ?? "Push").slice(0, MAX_THREAD_TITLE),
              detail: headline,
            });
          }).pipe(Effect.ignore);

        /** Follows a pushed commit's CI until its runs end. */
        const follow = (id: string) =>
          Effect.gen(function* () {
            const first = records.get(id);
            if (first === undefined || first.head === undefined) return;
            const target = yield* targetOf(first.cwd, first.remote);
            if (target === undefined) {
              yield* setCi(id, {
                state: "unavailable",
                note: "This remote isn't on GitHub, so there are no checks to follow.",
                runs: [],
                checks: [],
                failures: [],
              });
              return;
            }
            yield* update(id, (push) => ({
              ...push,
              repository:
                target._tag === "GitHub"
                  ? `${target.repository.owner}/${target.repository.name}`
                  : "cerium/simulated",
            }));
            const since = Date.now();
            let failures = 0;
            while (true) {
              const push = records.get(id);
              if (push === undefined) return;
              const polled = yield* Effect.result(poll(push, target));
              if (polled._tag === "Failure") {
                failures++;
                // Before its first answer, GitHub saying no is likely `gh` missing or signed out.
                if (failures >= (push.ci === undefined ? 3 : MAX_POLL_FAILURES)) {
                  yield* setCi(id, {
                    ...(push.ci ?? { runs: [], checks: [], failures: [] }),
                    state: "unavailable",
                    note: `Cerium couldn't follow the checks: ${polled.failure.message}`,
                  });
                  return;
                }
                yield* Effect.sleep("10 seconds");
                continue;
              }
              failures = 0;
              const { runs, checks } = polled.success;
              const kept = (push.ci?.failures ?? []).filter((failure) =>
                checks.some((check) => check.id === failure.checkId && check.state === "failed"),
              );
              const fresh: Array<CheckFailure> = [];
              for (const check of checks) {
                if (check.state !== "failed" || kept.some((failure) => failure.checkId === check.id))
                  continue;
                fresh.push(yield* failureOf(check, target));
              }
              let state = rollup(runs, checks);
              const waitedOut = runs.length === 0 && Date.now() - since > RUNS_APPEAR_WITHIN;
              if (waitedOut) state = "none";
              if (state === "cancelled" && !cancelled.has(id) && (yield* superseded(push, target))) {
                state = "superseded";
              }
              const over = state !== "waiting" && state !== "running";
              const next = yield* setCi(id, {
                state,
                ...(waitedOut ? { note: "No CI runs started for this push." } : {}),
                runs,
                checks,
                failures: [...kept, ...fresh],
                ...(over ? { finishedAt: Date.now() } : {}),
              });
              if (over) {
                cancelled.delete(id);
                if (next !== undefined) {
                  yield* tellEnd(next);
                  yield* PubSub.publish(ciEnded, next);
                }
                return;
              }
              if (Date.now() - since > FOLLOW_FOR) {
                yield* setCi(id, {
                  ...(next?.ci ?? { runs, checks, failures: [] }),
                  state: "unavailable",
                  note: "Cerium stopped following these checks after 6 hours.",
                });
                return;
              }
              yield* Effect.sleep(
                target._tag === "Simulated" ? "1 second" : runs.length === 0 ? "5 seconds" : "10 seconds",
              );
            }
          });

        const startFollowing = (id: string) => FiberMap.run(watchers, id, follow(id));

        // -------------------------------------------------------------------------------------
        // Pushing

        /** Runs a recorded push to its end, then follows its CI; `settled` gets how the push went. */
        const run = (
          id: string,
          agentId: AgentId,
          args: ReadonlyArray<string>,
          settled: Deferred.Deferred<PushRecord>,
        ) =>
          Effect.gen(function* () {
            const start = records.get(id);
            if (start === undefined) return;
            const sent = yield* send(id, args, start.cwd).pipe(
              Effect.timeoutOption(PUSH_TIMEOUT),
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            );
            const now = Date.now();
            const outcome =
              sent === undefined
                ? {
                    stage: "failed" as const,
                    message: "Git couldn't run, or the push took longer than 30 minutes and was stopped.",
                  }
                : pushOutcome(sent.code, sent.output, sent.progress.sending);
            const head =
              outcome.stage === "pushed"
                ? yield* line(start.cwd, ["rev-parse", `refs/heads/${start.branch}`]).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined;
            const done = yield* update(id, (push) => ({
              ...push,
              stage: outcome.stage,
              hook: finishHook(
                sent?.progress.hook ?? push.hook,
                outcome.stage !== "failed" || sent?.progress.sending === true,
                now,
              ),
              ...(sent === undefined ? {} : { output: sent.output }),
              ...(outcome.message === undefined ? {} : { message: outcome.message }),
              ...(head === undefined ? {} : { head }),
            }));
            pushing.delete(agentId);
            if (done === undefined) return;
            yield* Deferred.succeed(settled, done);
            if (done.stage === "pushed" && done.commits.length > 0) yield* startFollowing(id);
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                pushing.delete(agentId);
                if (yield* Deferred.isDone(settled)) return;
                const left = yield* update(id, (push) => ({
                  ...push,
                  stage: "failed",
                  hook: finishHook(push.hook, false, Date.now()),
                  message: "The push stopped before git finished.",
                }));
                if (left !== undefined) yield* Deferred.succeed(settled, left);
              }),
            ),
          );

        const push = Effect.fn("Pushes.push")(function* (agentId: AgentId, request: PushRequest) {
          const agent = yield* orchestrator.agent(agentId);
          const thread = (yield* orchestrator.listThreads).find((each) => each.id === agent.threadId);
          const cwd = thread?.cwd;
          if (cwd === undefined) {
            return yield* new PushError({
              message: "This thread has no folder, so there's nothing to push.",
            });
          }
          if (pushing.has(agentId)) {
            return yield* new PushError({
              message: "Your last push is still running: wait for how it went.",
            });
          }
          const target = yield* resolve(cwd, request);
          const decision = yield* orchestrator.requestApproval(agentId, {
            toolName: "push",
            summary: `Push ${target.branch} to ${target.remote}`,
            input: { remote: target.remote, branch: target.branch },
          });
          if (decision.decision === "deny") {
            return {
              status: "denied",
              note: decision.message ?? "The user didn't allow this push.",
            } satisfies PushAnswer;
          }
          if (pushing.has(agentId)) {
            return yield* new PushError({
              message: "Your last push is still running: wait for how it went.",
            });
          }
          const commits = yield* unpushed(cwd, target.branch, target.remote, target.remoteBranch);
          const id = `push_${randomUUID()}`;
          const now = Date.now();
          const record: PushRecord = {
            id,
            threadId: agent.threadId,
            agentId,
            cwd,
            remote: target.remote,
            branch: target.branch,
            createdAt: now,
            updatedAt: now,
            stage: "checking",
            hook: [],
            output: "",
            commits,
          };
          records.set(id, record);
          pushing.add(agentId);
          yield* publish(record);
          const args = [
            "push",
            ...(target.upstream ? [] : ["--set-upstream"]),
            target.remote,
            `refs/heads/${target.branch}:refs/heads/${target.remoteBranch}`,
          ];
          const settled = yield* Deferred.make<PushRecord>();
          yield* FiberMap.run(runners, id, run(id, agentId, args, settled));
          const outcome = yield* Deferred.await(settled).pipe(Effect.timeoutOption(ANSWER_WITHIN));
          if (Option.isNone(outcome)) {
            // The agent hears how it went once the hook is done.
            yield* FiberMap.run(
              publishing,
              `${id}:answer`,
              Deferred.await(settled).pipe(
                Effect.flatMap((done) =>
                  done.stage === "pushed"
                    ? orchestrator.notify(agentId, outcomeNote(done))
                    : orchestrator.wake(agentId, outcomeNote(done)).pipe(Effect.ignore),
                ),
              ),
            );
            return { status: "checking", pushId: id, note: outcomeNote(record) } satisfies PushAnswer;
          }
          const done = outcome.value;
          return {
            status: done.stage === "pushed" ? "pushed" : done.stage === "rejected" ? "rejected" : "failed",
            pushId: id,
            note: outcomeNote(done),
          } satisfies PushAnswer;
        });

        // -------------------------------------------------------------------------------------
        // The user's actions

        const act = Effect.fn("Pushes.act")(function* (pushId: string, action: PushAction) {
          const push = yield* find(pushId);
          const ci = push.ci;
          if (action === "sendToAgent") {
            yield* orchestrator
              .wake(push.agentId, failureNote(push))
              .pipe(Effect.mapError((error) => new PushError({ message: error.message })));
            return;
          }
          if (ci === undefined || push.head === undefined) {
            return yield* new PushError({ message: "This push has no CI runs." });
          }
          const target = yield* targetOf(push.cwd, push.remote);
          if (target === undefined)
            return yield* new PushError({ message: "This push's checks aren't on GitHub." });
          if (action === "cancel") {
            cancelled.add(pushId);
            if (target._tag === "Simulated") {
              yield* FiberMap.remove(watchers, pushId);
              yield* setCi(pushId, {
                ...ci,
                state: "cancelled",
                runs: ci.runs.map((each) => (finished(each.state) ? each : { ...each, state: "cancelled" })),
                checks: ci.checks.map((each) =>
                  finished(each.state) ? each : { ...each, state: "cancelled" },
                ),
                finishedAt: Date.now(),
              });
              return;
            }
            for (const each of ci.runs.filter((one) => !finished(one.state))) {
              yield* rest(target, "POST", `actions/runs/${each.id}/cancel`);
            }
            yield* startFollowing(pushId);
            return;
          }
          const failed = ci.runs.filter((each) => each.state === "failed");
          if (failed.length === 0) return yield* new PushError({ message: "No run of this push failed." });
          if (target._tag === "Simulated") {
            const attempt = (simulated.get(pushId)?.attempt ?? 1) + 1;
            simulated.set(pushId, { startedAt: Date.now(), attempt });
          } else {
            for (const each of failed) {
              yield* rest(target, "POST", `actions/runs/${each.id}/rerun-failed-jobs`);
            }
          }
          const { finishedAt: _, ...open } = ci;
          yield* setCi(pushId, {
            ...open,
            state: "running",
            failures: [],
            runs: ci.runs.map((each) => (each.state === "failed" ? { ...each, state: "queued" } : each)),
            checks: ci.checks.map((each) =>
              each.state === "failed" || each.state === "cancelled" ? { ...each, state: "queued" } : each,
            ),
          });
          yield* startFollowing(pushId);
        });

        // -------------------------------------------------------------------------------------
        // Starting up: what the file kept, and the watches a restart cut short

        const saved = yield* fs.readFileString(options.file).pipe(
          Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(PushFile))(text)),
          Effect.map((file) => file.pushes),
          Effect.orElseSucceed((): ReadonlyArray<PushRecord> => []),
        );
        for (const each of saved) {
          records.set(
            each.id,
            each.stage === "checking" || each.stage === "pushing"
              ? {
                  ...each,
                  stage: "failed",
                  message: "Cerium closed while this push ran, so how it went is unknown.",
                }
              : each,
          );
        }
        for (const each of records.values()) {
          if (each.ci?.state === "waiting" || each.ci?.state === "running") yield* startFollowing(each.id);
        }

        return Pushes.of({
          watch: (threadId) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(changes);
                return Stream.concat(
                  Stream.succeed(threadId),
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((changed) => changed === threadId),
                  ),
                ).pipe(Stream.map(() => ofThread(threadId)));
              }),
            ),
          act,
          push,
          ciEnded: Stream.fromPubSub(ciEnded),
        });
      }),
    );
    const host = Layer.effect(
      PushHost,
      Effect.gen(function* () {
        const service = yield* Pushes;
        return PushHost.of({
          push: (agentId, request) =>
            service
              .push(agentId, request)
              .pipe(
                Effect.mapError((error) =>
                  error instanceof PushError
                    ? new OrchestratorError({ reason: "invalid", message: error.message })
                    : error,
                ),
              ),
        });
      }),
    );
    return host.pipe(Layer.provideMerge(pushes));
  };
}
