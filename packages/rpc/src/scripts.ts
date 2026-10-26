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

/**
 * A project's setup and run commands, as they'd run; absent when nothing offers one.
 */
export const ProjectScripts = Schema.Struct({
  setup: Schema.optionalKey(ResolvedScript),
  run: Schema.optionalKey(ResolvedScript),
});
export type ProjectScripts = typeof ProjectScripts.Type;

/** Which of a project's commands it is. */
export const ScriptKind = Schema.Literals(["setup", "run"]);
export type ScriptKind = typeof ScriptKind.Type;

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
);
