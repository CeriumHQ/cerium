import { array, count, record, string, type AcpConnection, type AcpSession } from "@cerium/acp";
import type { BackgroundTask } from "@cerium/protocol";
import { Effect, Scope, Semaphore } from "effect";

export const makeGrokTasks = Effect.fn("Grok.tasks")(function* (acp: AcpConnection, sessionId: string) {
  const scope = yield* Scope.Scope;
  const serial = yield* Semaphore.make(1);
  let last = "[]";
  const refresh = (session: AcpSession) =>
    serial.withPermit(
      Effect.gen(function* () {
        const response = record(yield* acp.call("_x.ai/task/list", { sessionId }, "5 seconds"));
        const tasks = array(record(response?.["result"])?.["tasks"]).flatMap(
          (value): ReadonlyArray<BackgroundTask> => {
            const task = record(value);
            const id = string(task?.["task_id"]);
            if (
              !id ||
              task?.["owner_session_id"] !== sessionId ||
              task["completed"] !== false ||
              task["is_backgrounded"] !== true
            )
              return [];
            const command = string(task["command"]);
            const started = record(task["start_time"]);
            const seconds = count(started?.["secs_since_epoch"]);
            const nanos = count(started?.["nanos_since_epoch"]) ?? 0;
            return [
              {
                id,
                kind: task["kind"] === "bash" ? "command" : "other",
                description: string(task["description"]) ?? command ?? "Background task",
                ...(command === undefined ? {} : { command }),
                ...(seconds === undefined
                  ? {}
                  : { startedAt: seconds * 1000 + Math.floor(nanos / 1_000_000) }),
                stoppable: true,
              },
            ];
          },
        );
        const snapshot = JSON.stringify(tasks);
        if (snapshot === last) return;
        last = snapshot;
        yield* session.emit({ _tag: "BackgroundTasksChanged", tasks });
      }),
    );
  return {
    /** The receive loop can't await a request on its own connection. */
    refreshInBackground: (session: AcpSession) =>
      refresh(session).pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
    stop: (session: AcpSession, taskId: string) =>
      Effect.gen(function* () {
        const response = record(yield* acp.call("_x.ai/task/kill", { sessionId, taskId }, "5 seconds"));
        const outcome = record(response?.["result"])?.["outcome"];
        if (outcome !== "killed" && outcome !== "not_found" && outcome !== "already_completed") {
          return yield* acp.failure("Grok Build could not stop the background task");
        }
        yield* refresh(session);
      }),
  };
});
