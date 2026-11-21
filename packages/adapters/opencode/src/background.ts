import { HarnessFailure } from "@cerium/harness";
import type { BackgroundTask } from "@cerium/protocol";
import { Effect, Queue, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";

import { call, type OpenCodeHost } from "./host.ts";

const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  sessionID: Schema.NonEmptyString,
  kind: Schema.String,
  title: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.NonEmptyString),
  status: Schema.String,
  time: Schema.Struct({ started: Schema.Finite }),
});
const decodeJobs = Schema.decodeUnknownEffect(Schema.Struct({ data: Schema.Array(Job) }));
type Job = typeof Job.Type;

const failure = (message: string, cause?: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

/** The job catalog was added after the pinned client. An older server answers 404 for the route. */
export const readJobs = (host: Pick<OpenCodeHost, "get">, sessionID: string) =>
  call("list background jobs", async (signal) => {
    const query = new URLSearchParams({ sessionID, status: "running" }).toString();
    const reply = await host.get(`/api/experimental/job?${query}`, signal);
    if (reply.status === 404) return undefined;
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    return { body: (await reply.json()) as unknown };
  }).pipe(
    Effect.flatMap((response) =>
      response === undefined
        ? Effect.succeed(undefined)
        : decodeJobs(response.body).pipe(
            Effect.map(({ data }) =>
              data.filter((job) => job.sessionID === sessionID && job.status === "running"),
            ),
            Effect.mapError((cause) => failure("OpenCode returned an invalid background job list", cause)),
          ),
    ),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => failure("OpenCode timed out listing background jobs"),
    }),
  );

export const toBackgroundTask = (job: Job): BackgroundTask => ({
  id: job.id,
  kind: job.kind === "shell" ? "command" : job.kind === "subagent" ? "agent" : "other",
  description: job.title || job.description || job.command || job.kind,
  ...(job.command ? { command: job.command } : {}),
  startedAt: job.time.started,
  // v2.3 has shell.remove. Its job catalog has no public cancellation operation for the other kinds.
  stoppable: job.kind === "shell" && job.shellID !== undefined,
});

export const watchBackgroundJobs = Effect.fn("OpenCodeAdapter.backgroundJobs")(function* (
  host: OpenCodeHost,
  sessionID: string,
  cwd: string,
  publish: (tasks: ReadonlyArray<BackgroundTask>) => void,
) {
  const changes = yield* Queue.sliding<void>(1);
  let jobs: ReadonlyArray<Job> = [];
  yield* Effect.gen(function* () {
    for (;;) {
      const next = yield* readJobs(host, sessionID).pipe(
        Effect.catch((error) =>
          Effect.logDebug("Could not read OpenCode's background jobs", error).pipe(Effect.as(jobs)),
        ),
      );
      if (next === undefined) {
        yield* Queue.shutdown(changes);
        return;
      }
      if (!isDeepStrictEqual(next, jobs)) {
        jobs = next;
        publish(jobs.map(toBackgroundTask));
      }
      // Older job catalogs lack change events for some job kinds; only poll while a job is running.
      yield* jobs.length === 0
        ? Queue.take(changes)
        : Queue.take(changes).pipe(
            Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
          );
    }
  }).pipe(Effect.forkScoped);
  return {
    changed: () => Queue.offerUnsafe(changes, undefined),
    stop: (id: string) =>
      Effect.gen(function* () {
        const job = jobs.find((each) => each.id === id);
        if (job === undefined) return;
        const shell = job.shellID;
        if (job.kind !== "shell" || shell === undefined) {
          return yield* failure("This OpenCode background job cannot be stopped through the API");
        }
        yield* call("stop the background command", (signal) =>
          host.client.shell.remove({ id: shell, location: { directory: cwd } }, { signal }),
        );
        Queue.offerUnsafe(changes, undefined);
      }),
  };
});
