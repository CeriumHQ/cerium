import type { AgentId } from "@cerium/protocol";
import { Effect } from "effect";

import type { OrchestratorContext } from "./context.ts";
import { notAllowed, OrchestratorError } from "./errors.ts";
import { isHelper } from "./runtime.ts";
import type { ScriptKind, ScriptsError, ScriptStatus } from "./scripts.ts";
import type { UserRequests } from "./userRequests.ts";

// What the bus's `project_run` tool asks of a thread's project scripts and what it answers: the
// agents start, stop and restart the project's run (or setup) in the thread's own terminal, and read
// how it stands and what it printed.

export type ProjectRunAction = "start" | "stop" | "restart" | "status";

export interface ProjectRunRequest {
  readonly action: ProjectRunAction;
  /** Which of the project's scripts; `run` when left out. */
  readonly script?: ScriptKind;
  /** How many of its last lines of output to answer with. */
  readonly lines?: number;
}

/**
 * `running` (its shell is going), `exited` (it ended with `exitCode`), `stopped` (no terminal: never
 * started, or stopped), or `denied` (the user didn't allow it: nothing changed).
 */
export type ProjectRunState = "running" | "exited" | "stopped" | "denied";

export interface ProjectRunAnswer {
  readonly script: ScriptKind;
  /** The command the project's script runs, when it has one. */
  readonly command?: string;
  readonly state: ProjectRunState;
  readonly exitCode?: number;
  /** The first local address the run printed. */
  readonly url?: string;
  /** The last lines it printed, in plain text. */
  readonly output: string;
  readonly note: string;
}

/** How many lines of output an answer holds unless asked for another number, and the most it may. */
export const DEFAULT_RUN_LINES = 40;
export const MAX_RUN_LINES = 200;

/** How long a start waits for the run to print its address or end, inside every harness's MCP timeout (Codex: 60s). */
export const START_WAITS_FOR = "15 seconds";

/** The number of lines asked for, within what an answer may hold. */
export const runLines = (asked: number | undefined): number =>
  Math.min(MAX_RUN_LINES, Math.max(1, Math.trunc(asked ?? DEFAULT_RUN_LINES)));

/** The answer for a script as its terminal stands now; `status` is absent when it has none. */
export const runAnswer = (
  script: ScriptKind,
  status: ScriptStatus | undefined,
  options: { readonly command?: string | undefined; readonly note?: string } = {},
): ProjectRunAnswer => {
  const { command } = options;
  const base = { script, ...(command === undefined ? {} : { command }) };
  if (status === undefined) {
    return {
      ...base,
      state: "stopped",
      output: "",
      note: options.note ?? "Not running: nothing started it in this thread, or it was stopped.",
    };
  }
  const { running, exitCode, url, output } = status;
  const note =
    options.note ??
    (running
      ? url !== undefined
        ? `Serving at ${url}. Open it in your thread's browser with browser_open.`
        : script === "run"
          ? "Running; it hasn't printed a local address yet. Call status again to see whether it has."
          : "Still running; your thread's lead is told when it ends. Call status to see how it is going."
      : exitCode === 0
        ? "Finished."
        : `Failed with exit code ${exitCode}: its output says why.`);
  return {
    ...base,
    state: running ? "running" : "exited",
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(url === undefined ? {} : { url }),
    output,
    note,
  };
};

/**
 * The `project_run` tool: starts, stops or restarts the caller's thread's project run (or setup), or
 * reads how it stands. Starting asks like a command does, through `requestApproval`.
 */
export const makeProjectRun = (
  { runtime, scripts, threadInfo }: OrchestratorContext,
  requestApproval: UserRequests["requestApproval"],
) => {
  const projectRun = Effect.fn("Orchestrator.projectRun")(function* (
    callerId: AgentId,
    request: ProjectRunRequest,
  ) {
    const caller = yield* runtime(callerId);
    if (isHelper(caller.info)) {
      return yield* notAllowed("An advisor or reviewer doesn't run the project.");
    }
    const kind = request.script ?? "run";
    const lines = runLines(request.lines);
    const thread = yield* threadInfo(caller.info.threadId);
    const folder = thread.cwd;
    if (thread.mode !== "work" || folder === undefined) {
      return yield* notAllowed("This thread has no project folder, so there is nothing to run.");
    }
    const project = thread.worktree?.project ?? folder;
    const failed = (error: ScriptsError) =>
      new OrchestratorError({ reason: "invalid", message: error.message });
    const command = (yield* scripts.resolve(project).pipe(Effect.mapError(failed)))[kind];
    const standing = () => scripts.status(thread.id, kind, lines);

    if (request.action === "status") {
      return runAnswer(kind, yield* standing(), { command: command?.text });
    }
    /** Asks as a command does; what the answer is when it isn't allowed, and nothing when it is. */
    const refusal = Effect.fn("Orchestrator.projectRun.approve")(function* (summary: string) {
      const decision = yield* requestApproval(callerId, {
        toolName: "project_run",
        summary,
        input: { action: request.action, script: kind },
      });
      return decision.decision === "deny"
        ? ({
            ...runAnswer(kind, undefined, {
              command: command?.text,
              note: decision.message ?? "The user didn't allow this.",
            }),
            state: "denied",
          } satisfies ProjectRunAnswer)
        : undefined;
    });

    if (request.action === "stop") {
      const refused = yield* refusal(`Stop the project's ${kind}`);
      if (refused !== undefined) return refused;
      const stopped = yield* scripts.stop(thread.id, kind);
      return runAnswer(kind, undefined, {
        command: command?.text,
        note: stopped ? "Stopped." : "It wasn't running.",
      });
    }

    if (command === undefined) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `No ${kind} command is set for this project. Ask the user to set one in Settings → Git & GitHub.`,
      });
    }
    if (command.from === "guessed") {
      return yield* notAllowed(
        `Cerium only guesses this project's ${kind} (\`${command.text}\`), and a guess never runs by itself. Ask the user to confirm it in Settings → Git & GitHub, or to press ${kind === "run" ? "Run" : "Setup"}.`,
      );
    }
    if (request.action === "start") {
      const current = yield* standing();
      if (current?.running === true) {
        return runAnswer(kind, current, {
          command: command.text,
          note: `Already running, so it wasn't started again; \`restart\` runs it again.${
            current.url === undefined ? "" : ` Serving at ${current.url}.`
          }`,
        });
      }
    }
    const refused = yield* refusal(
      `${request.action === "start" ? "Start" : "Restart"} the project's ${kind}: ${command.text}`,
    );
    if (refused !== undefined) return refused;
    yield* scripts
      .start({
        kind,
        threadId: thread.id,
        project,
        cwd: folder,
        settleWithin: START_WAITS_FOR,
      })
      .pipe(Effect.mapError(failed));
    return runAnswer(kind, yield* standing(), { command: command.text });
  });
  return projectRun;
};
