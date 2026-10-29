import { ThreadId } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";
import { TerminalInfo, TerminalSize } from "./terminal.ts";

// A project's setup and run commands: what makes a worktree usable, and what keeps the project
// running there. They're resolved each time (`ResolvedScript`) from the user's local choice in
// Cerium's saved projects, then the project's `.cerium.toml`, then a guess from its package
// manager, and the same script's terminal replaces the one before it.

/** Where a script came from. A `guessed` one is shown for the user to confirm, never run alone. */
export const ScriptSource = Schema.Literals(["saved", "project", "guessed"]);
export type ScriptSource = typeof ScriptSource.Type;

/** One command of a project, and which side offered it. */
export const ResolvedScript = Schema.Struct({
  text: Schema.String,
  from: ScriptSource,
});
export type ResolvedScript = typeof ResolvedScript.Type;

/** One of a project's named commands (Test, Lint, Migrate): never guessed, so `from` is `saved` or `project`. */
export const ResolvedAction = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
  from: ScriptSource,
});
export type ResolvedAction = typeof ResolvedAction.Type;

/**
 * A project's setup and run commands, as they'd run; absent when nothing offers one. `actions` are
 * its named commands, in the order they run in menus; they all come from the same side, the user's
 * saved list when they have one (empty when they turned the project's off), else the project's
 * `[actions]`, absent when it has none. Since `RPC_VERSION` 39.
 */
export const ProjectScripts = Schema.Struct({
  setup: Schema.optionalKey(ResolvedScript),
  run: Schema.optionalKey(ResolvedScript),
  actions: Schema.optionalKey(Schema.Array(ResolvedAction)),
});
export type ProjectScripts = typeof ProjectScripts.Type;

/** Which of a project's commands it is. */
export const ScriptKind = Schema.Literals(["setup", "run"]);
export type ScriptKind = typeof ScriptKind.Type;

/** One named command as the user saves it, or as `.cerium.toml`'s `[actions]` holds it. */
export const ActionCommand = Schema.Struct({ name: Schema.String, command: Schema.String });
export type ActionCommand = typeof ActionCommand.Type;

/** How long the field for an action's name lets it be: the name labels a terminal's tab and a menu's row. */
export const ACTION_NAME_MAX = 32;

/** The names an action can't take: the project's own scripts, which label their terminals already. */
const RESERVED_ACTION_NAMES = ["setup", "run", "teardown"];

/**
 * Why `name` can't name one of a project's actions, written for the user, or undefined when it can.
 * `others` are the project's other actions' names, which it has to differ from, ignoring case.
 */
export const actionNameProblem = (name: string, others: ReadonlyArray<string>): string | undefined => {
  const trimmed = name.trim();
  if (trimmed === "") return "Give it a name.";
  for (let at = 0; at < trimmed.length; at++) {
    const code = trimmed.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return "No control characters.";
  }
  const lower = trimmed.toLowerCase();
  if (RESERVED_ACTION_NAMES.includes(lower)) return `${trimmed} is a script of its own.`;
  if (others.some((other) => other.trim().toLowerCase() === lower)) return "That name is taken.";
  return undefined;
};

/** The first problem a list of actions has with its names, written for the user, or undefined when it has none. */
export const actionListProblem = (actions: ReadonlyArray<{ readonly name: string }>): string | undefined => {
  for (const [at, { name }] of actions.entries()) {
    const problem = actionNameProblem(
      name,
      actions.slice(0, at).map((each) => each.name),
    );
    if (problem !== undefined) return name.trim() === "" ? problem : `${name.trim()}: ${problem}`;
  }
  return undefined;
};

/** What one command serves: `project` is the folder the user picked the project by. */
export const ScriptRpcs = RpcGroup.make(
  /** A project's setup and run commands, resolved. Since `RPC_VERSION` 29. */
  Rpc.make("ProjectScripts", {
    payload: { project: Schema.NonEmptyString },
    success: ProjectScripts,
    error: CeriumError,
  }),
  /**
   * Stores a project's own setup and run commands, which take them off its `.cerium.toml`: `null`
   * defers again, `""` turns the command off. Saves the folder as a project when it isn't one.
   * Since `RPC_VERSION` 29.
   */
  Rpc.make("SetProjectScripts", {
    payload: {
      path: Schema.NonEmptyString,
      setup: Schema.NullOr(Schema.String),
      run: Schema.NullOr(Schema.String),
      /**
       * The user's own named commands, which replace the project's `[actions]` whole; `null` defers to
       * the file again, absent leaves what was saved. Since `RPC_VERSION` 39.
       */
      actions: Schema.optionalKey(Schema.NullOr(Schema.Array(ActionCommand))),
    },
    error: CeriumError,
  }),
  /**
   * Writes the commands into the project's `.cerium.toml` so its team shares them: its `[scripts]`
   * setup and run (an empty one is taken out) and its `[actions]`, creating the file when there is
   * none and keeping the rest of it as it is. The user's own saved commands for the project, which
   * the file would be shadowed by, are cleared. Since `RPC_VERSION` 39.
   */
  Rpc.make("WriteProjectScriptsFile", {
    payload: {
      path: Schema.NonEmptyString,
      setup: Schema.String,
      run: Schema.String,
      actions: Schema.Array(ActionCommand),
    },
    error: CeriumError,
  }),
  /**
   * Starts one of a work thread's commands in a terminal of the thread's own (`RunProjectScript`),
   * replacing the same kind's terminal when it has one: `setup` installs what the project needs,
   * `run` runs it, printing the URL a dev server serves as `Url` output pieces.
   */
  Rpc.make("RunProjectScript", {
    payload: { threadId: ThreadId, kind: ScriptKind, size: TerminalSize },
    success: TerminalInfo,
    error: CeriumError,
  }),
  /**
   * Starts one of the project's named commands in a terminal of the work thread's own, whose tab
   * shows its name; running it again replaces its terminal. Since `RPC_VERSION` 39.
   */
  Rpc.make("RunProjectAction", {
    payload: { threadId: ThreadId, name: Schema.NonEmptyString, size: TerminalSize },
    success: TerminalInfo,
    error: CeriumError,
  }),
);
