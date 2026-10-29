import { ThreadId } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";
import { TerminalInfo, TerminalSize } from "./terminal.ts";

// A project's setup, run and teardown commands: what makes a worktree usable, what keeps the project
// running there, and what cleans up after it before the worktree goes. They're resolved each time
// (`ResolvedScript`) from the user's local choice in Cerium's saved projects, then the project's
// `.cerium.toml`, then a guess from its package manager, and the same script's terminal replaces
// the one before it.

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
 * A project's setup, run and teardown commands, as they'd run; absent when nothing offers one.
 * `teardown` since `RPC_VERSION` 39.
 */
export const ProjectScripts = Schema.Struct({
  setup: Schema.optionalKey(ResolvedScript),
  run: Schema.optionalKey(ResolvedScript),
  teardown: Schema.optionalKey(ResolvedScript),
});
export type ProjectScripts = typeof ProjectScripts.Type;

/**
 * A teardown that didn't end well, for the user to read once its thread is already put away: the
 * command, and why in a line (its exit code and the end of its output, or that it ran out of time).
 * Since `RPC_VERSION` 39.
 */
export const TeardownReport = Schema.Struct({
  script: Schema.String,
  failure: Schema.String,
});
export type TeardownReport = typeof TeardownReport.Type;

/** Which of a project's commands runs in a terminal of the thread's own. */
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
   * Stores a project's own setup, run and teardown commands, which take them off its `.cerium.toml`:
   * `null` defers again, `""` turns the command off, and one left out stays as it was (since
   * `RPC_VERSION` 39). Saves the folder as a project when it isn't one. Since `RPC_VERSION` 29.
   */
  Rpc.make("SetProjectScripts", {
    payload: {
      path: Schema.NonEmptyString,
      setup: Schema.optionalKey(Schema.NullOr(Schema.String)),
      run: Schema.optionalKey(Schema.NullOr(Schema.String)),
      teardown: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
