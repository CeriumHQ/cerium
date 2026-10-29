import { ThreadId } from "@cerium/protocol";
import { Context, Effect, Layer, Schema, Stream } from "effect";

// A project's setup, run and teardown commands, as the scripts threads' worktrees need. The backend
// resolves them (Cerium's saved projects, the project's `.cerium.toml`, else a guess from its package
// manager) and runs setup and run in a terminal of the thread's own, where their output shows; the
// orchestrator starts setup as a worktree is made for the thread, and tells the lead what became of
// it, so it doesn't build before what setup installs is there. Teardown runs out of sight when the
// thread is put away, before its worktree goes.

/** Why scripts couldn't be resolved, stored or run; `message` is written for the user. */
export class ScriptsError extends Schema.TaggedError<ScriptsError>()("ScriptsError", {
  message: Schema.String,
}) {}

/** Where a resolved command comes from. A guess is shown for the user to confirm, never run alone. */
export type ScriptSource = "saved" | "project" | "guessed";

/** One of a project's commands, and the side that offered it. */
export interface ResolvedScript {
  readonly text: string;
  readonly from: ScriptSource;
}

/** One of a project's named commands (Test, Lint, Migrate): saved or the project's own, never guessed. */
export interface ResolvedAction extends ResolvedScript {
  readonly name: string;
}

/**
 * A project's setup, run and teardown commands; any is absent when nothing offers it. `actions` are
 * its named commands: the user's saved list when they have one, else the project's `[actions]`.
 */
export interface ResolvedScripts {
  readonly setup?: ResolvedScript;
  readonly run?: ResolvedScript;
  readonly teardown?: ResolvedScript;
  readonly actions?: ReadonlyArray<ResolvedAction>;
}

/** Which of a project's commands runs in a terminal of the thread's own. */
export type ScriptKind = "setup" | "run";

/** A teardown that didn't end well: the command, and why in a line for the user. */
export interface TeardownFailure {
  readonly script: string;
  readonly failure: string;
}

/** The block of ports a work thread was given: `first` is its `CERIUM_PORT`. */
export interface ThreadPorts {
  readonly first: number;
  readonly last: number;
}

export type ScriptStarted =
  | { readonly _tag: "Ran"; readonly script: string; readonly from: ScriptSource }
  | { readonly _tag: "Guess"; readonly script: string };

/** How a script's run ended, `code` undefined when its terminal was closed with it. */
export interface ScriptEnded {
  readonly threadId: ThreadId;
  readonly kind: ScriptKind;
  readonly script: string;
  readonly code: number | undefined;
}

/**
 * Scripts by project. Implementations need `Store` for the saved ones, `FileSystem` and `Path` to
 * read the project's own file, and a terminal service to run in.
 */
export class ProjectScripts extends Context.Service<
  ProjectScripts,
  {
    /** The project's setup and run commands as they'd run. */
    resolve(project: string): Effect.Effect<ResolvedScripts, ScriptsError>;
    /**
     * Runs `kind` for a work thread, in a terminal of the thread's own in `cwd`. With `auto`, only a
     * confirmed command runs — a saved one, or one the project's file holds; a guess comes back
     * instead for the user to confirm, and nothing when the project has no command at all. Without
     * it, any of the three runs, and refusing when there's none.
     */
    start(options: {
      readonly kind: ScriptKind;
      readonly threadId: ThreadId;
      /** The folder the user picked the project by. */
      readonly project: string;
      /** The folder the script runs in: the thread's own. */
      readonly cwd: string;
      readonly size?: { readonly cols: number; readonly rows: number };
      readonly auto?: boolean;
    }): Effect.Effect<ScriptStarted | undefined, ScriptsError>;
    /**
     * Runs one of the project's named commands for a work thread, in a terminal of the thread's own
     * in `cwd` whose tab shows its name; the same name's terminal there is replaced. Its end isn't
     * reported (`ended`): the user started it, and watches it. Refused when the project has no
     * action of that name. Resolves the command that ran.
     */
    startAction(options: {
      readonly name: string;
      readonly threadId: ThreadId;
      readonly project: string;
      readonly cwd: string;
      readonly size?: { readonly cols: number; readonly rows: number };
    }): Effect.Effect<ResolvedAction, ScriptsError>;
    /**
     * Writes the commands into the project's `.cerium.toml` (setup, run and teardown, an empty one
     * taken out and an absent teardown left as it is, and the named actions), making the file if there
     * is none and keeping the rest of it. What the user saved for the project on this machine is
     * cleared, so the file is what resolves.
     */
    writeFile(options: {
      readonly project: string;
      readonly setup: string;
      readonly run: string;
      readonly teardown?: string;
      readonly actions: ReadonlyArray<{ readonly name: string; readonly command: string }>;
    }): Effect.Effect<void, ScriptsError>;
    /** How each run ends, started at the thread's creation or on demand. */
    readonly ended: Stream.Stream<ScriptEnded>;
    /**
     * Runs the project's teardown for a work thread in `cwd`, before its worktree is removed: out of
     * sight, to its end or a time limit, with the thread's environment. Only a confirmed command runs.
     * Never fails, since putting a thread away doesn't wait on it: it resolves with what went wrong,
     * and with nothing when teardown ended well or none is set.
     */
    teardown(options: {
      readonly threadId: ThreadId;
      /** The folder the user picked the project by. */
      readonly project: string;
      /** The folder the script runs in: the thread's own. */
      readonly cwd: string;
    }): Effect.Effect<TeardownFailure | undefined>;
    /** The block of ports a work thread has, giving it one the first time; none for a thread that can't have one. */
    ports(threadId: ThreadId): Effect.Effect<ThreadPorts | undefined>;
  }
>()("cerium/orchestrator/ProjectScripts") {
  /** For builds and tests without them: nothing is resolved and nothing runs. */
  static readonly unavailable = Layer.succeed(ProjectScripts, {
    resolve: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    start: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    startAction: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    writeFile: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    ended: Stream.empty,
    teardown: () => Effect.succeed(undefined),
    ports: () => Effect.succeed(undefined),
  });
}
