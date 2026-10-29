import { MAX_RUN_LINES, OrchestratorError } from "@cerium/orchestrator";
import { ScriptKind } from "@cerium/rpc";
import { Schema } from "effect";
import { Tool } from "effect/ai";

// `project_run`: the project's own commands, run in the thread's terminal where the user watches them.
// The orchestrator runs it (`Orchestrator.projectRun`); the bus only carries it.

export const ProjectRunRequest = Schema.Struct({
  action: Schema.Literals(["start", "stop", "restart", "status"]).annotate({
    description:
      "start: run it unless it already runs. restart: stop it and run it again. stop. status: how it" +
      " stands now and what it printed.",
  }),
  script: Schema.optionalKey(ScriptKind).annotate({
    description: "Which command: `run` (the default) or `setup`.",
  }),
  lines: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RUN_LINES })),
  ).annotate({ description: "How many of its last lines of output to answer with (40 by default)." }),
});
export type ProjectRunRequest = typeof ProjectRunRequest.Type;

export const ProjectRunAnswer = Schema.Struct({
  script: ScriptKind,
  command: Schema.optionalKey(Schema.String).annotate({ description: "The command it runs." }),
  state: Schema.Literals(["running", "exited", "stopped", "denied"]).annotate({
    description:
      "running; exited (see exitCode); stopped (no terminal: never started, or stopped); denied (the user" +
      " didn't allow it, and nothing changed).",
  }),
  exitCode: Schema.optionalKey(Schema.Int),
  url: Schema.optionalKey(Schema.String).annotate({
    description: "The first local address its output printed: where it serves.",
  }),
  output: Schema.String.annotate({ description: "Its last lines, as plain text." }),
  note: Schema.String,
});
export type ProjectRunAnswer = typeof ProjectRunAnswer.Type;

export const ProjectRun = Tool.make("project_run", {
  description:
    "Run your thread's project: the commands the user set for it (Settings → Git & GitHub). `script` `run`," +
    " the default, is its dev server or app; `setup` installs what it needs. They run in a terminal of your" +
    " thread's own, which the user watches. Give an `action`: `start`, `stop` or `restart` it, or ask its" +
    " `status`; each answers with its state (running, exited with its exitCode, stopped), the first local `url` it printed," +
    " and the last `lines` of its output as plain text. A start waits up to 15 seconds for the run to print" +
    " its address or end. Use it instead of starting the dev server in a shell of your own, which no one" +
    " can stop or read afterwards; open the `url` with browser_open. Your thread's lead hears when a run" +
    " prints its address and when one fails, with the end of its output. Starting asks like a command does," +
    " and runs only a command the user confirmed, never a guess.",
  parameters: ProjectRunRequest,
  success: ProjectRunAnswer,
  failure: OrchestratorError,
});
