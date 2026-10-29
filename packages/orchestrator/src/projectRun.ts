import type { ScriptKind, ScriptStatus } from "./scripts.ts";

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
