import { ThreadId } from "@cerium/protocol";
import { Context, Effect, Layer, Schema, Stream } from "effect";

// A project's setup and run commands, as the scripts threads' worktrees need. The backend resolves
// them (Cerium's saved projects, the project's `.cerium.toml`, else a guess from its package
// manager) and runs them in a terminal of the thread's own, where their output shows; the
// orchestrator starts setup as a worktree is made for the thread, and tells the lead what became of
// it, so it doesn't build before what setup installs is there.

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
 * A project's setup and run commands; either is absent when nothing offers it. `actions` are its
 * named commands: the user's saved list when they have one, else the project's `[actions]`.
 */
export interface ResolvedScripts {
  readonly setup?: ResolvedScript;
  readonly run?: ResolvedScript;
  readonly actions?: ReadonlyArray<ResolvedAction>;
}

/** Which of a project's commands it is. */
export type ScriptKind = "setup" | "run";

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
     * Writes the commands into the project's `.cerium.toml` (setup and run, an empty one taken out,
     * and the named actions), making the file if there is none and keeping the rest of it. What the
     * user saved for the project on this machine is cleared, so the file is what resolves.
     */
    writeFile(options: {
      readonly project: string;
      readonly setup: string;
      readonly run: string;
      readonly actions: ReadonlyArray<{ readonly name: string; readonly command: string }>;
    }): Effect.Effect<void, ScriptsError>;
    /** How each run ends, started at the thread's creation or on demand. */
    readonly ended: Stream.Stream<ScriptEnded>;
  }
>()("cerium/orchestrator/ProjectScripts") {
  /** For builds and tests without them: nothing is resolved and nothing runs. */
  static readonly unavailable = Layer.succeed(ProjectScripts, {
    resolve: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    start: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    startAction: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    writeFile: () => Effect.fail(new ScriptsError({ message: "Scripts aren't available here." })),
    ended: Stream.empty,
  });
}
