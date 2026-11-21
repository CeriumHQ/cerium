import { describe, expect, it } from "vite-plus/test";
import type { BackgroundTask } from "@cerium/protocol";
import { Effect, Queue } from "effect";

import { readJobs, watchBackgroundJobs } from "../src/background.ts";
import type { OpenCodeHost } from "../src/host.ts";

const shell = {
  id: "job-1",
  sessionID: "ses_1",
  kind: "shell",
  status: "running",
  shellID: "shell-1",
  command: "bun run dev",
  time: { started: 100 },
};
const other = {
  id: "job-2",
  sessionID: "ses_1",
  kind: "subagent",
  status: "running",
  description: "Check the diff",
  time: { started: 110 },
};

describe("OpenCode background jobs", () => {
  it("uses the session-scoped job catalog and tolerates servers without it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const paths: Array<string> = [];
        const oldHost = {
          get: (path: string) => {
            paths.push(path);
            return Promise.resolve(new Response(null, { status: 404 }));
          },
        };
        expect(yield* readJobs(oldHost, "ses_1")).toBeUndefined();
        expect(paths).toEqual(["/api/experimental/job?sessionID=ses_1&status=running"]);
      }),
    ));

  it("publishes owned running jobs and stops a shell by its native ID", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const published = yield* Queue.unbounded<ReadonlyArray<BackgroundTask>>();
        const calls: Array<unknown> = [];
        let jobs = [
          shell,
          other,
          { ...shell, id: "foreign", sessionID: "ses_2" },
          { ...other, id: "done", status: "completed" },
        ];
        const host = {
          get: () => Promise.resolve(Response.json({ data: jobs })),
          client: {
            shell: {
              remove: (input: unknown) => {
                calls.push(input);
                jobs = jobs.filter(({ id }) => id !== shell.id);
                return Promise.resolve();
              },
            },
          },
        } as unknown as OpenCodeHost;
        const tracker = yield* watchBackgroundJobs(host, "ses_1", "/work", (tasks) => {
          Queue.offerUnsafe(published, tasks);
        });
        expect(yield* Queue.take(published)).toMatchObject([
          { id: "job-1", kind: "command", stoppable: true },
          { id: "job-2", kind: "agent", stoppable: false },
        ]);
        yield* tracker.stop("foreign");
        expect(calls).toEqual([]);
        yield* tracker.stop("job-1");
        expect(calls).toEqual([{ id: "shell-1", location: { directory: "/work" } }]);
        expect(yield* Queue.take(published)).toMatchObject([{ id: "job-2" }]);
        jobs = [];
        tracker.changed();
        expect(yield* Queue.take(published)).toEqual([]);
      }).pipe(Effect.scoped),
    ));
});
