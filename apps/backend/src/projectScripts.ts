import {
  ProjectScripts,
  ScriptsError,
  type ResolvedScript,
  type ResolvedScripts,
  type ScriptEnded,
  type ScriptKind,
  type ScriptStarted,
} from "@cerium/orchestrator";
import { ThreadId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Effect, FileSystem, Layer, Option, Path, PubSub, Scope, Stream } from "effect";
import { lstatSync } from "node:fs";

import { Terminals } from "./terminal.ts";
import { chooseShell, scriptChoice, type ShellHost } from "./terminalShell.ts";

// What each project's worktree is made usable with: the setup command that runs as the worktree is
// made — the user's saved word for the project wins, then the project's own `.cerium.toml`, then a
// guess from its package manager that waits for the user — and the run command that keeps it going,
// whose output's dev-server address the terminal hands over. Scripts run in a terminal of the
// thread's own, where the user and its agents watch them.

/** The project's own file, checked into the repository so a team shares one pair of commands. */
const SCRIPT_FILE = ".cerium.toml";

/** The size a script's terminal starts at; its viewer fits it again. */
const SCRIPT_SIZE = { cols: 100, rows: 30 };

/** What a terminal's tab shows for the script it runs; a plain shell's tab shows its shell's name. */
export const SCRIPT_LABEL = { setup: "Setup", run: "Run" } as const;

/** What `[scripts]` of a `.cerium.toml` holds. */
export interface ScriptFile {
  readonly setup?: string;
  readonly run?: string;
}

/**
 * The two scripts a `.cerium.toml` holds, in its `[scripts]` section, quoted plainly or with single
 * quotes, its comments dropped. What the file holds elsewhere is left as its own: the fields get
 * commands, and nothing else of the file is Cerium's to read.
 */
export const scriptsFromToml = (text: string): ScriptFile => {
  const scripts: { setup?: string; run?: string } = {};
  let inScripts = false;
  for (const line of text.replace(/^\uFEFF/, "").split("\n")) {
    const entry = /^(?:\[([^[\]]+)\]|(setup|run)\s*=\s*(['"])([^'"]*)\3)\s*(?:#.*)?$/.exec(line.trim());
    if (entry === null) continue;
    // A section header is `[scripts]` itself; a subsection like `[scripts.more]` leaves it.
    if (entry[1] !== undefined) inScripts = entry[1] === "scripts";
    else if (inScripts) scripts[entry[2] as "setup" | "run"] = entry[4]!;
  }
  return scripts;
};

/** What a project's package.json says its run is: the script named `dev`, else `start`. */
const packageRun = (packageJson?: string): string | undefined => {
  if (packageJson === undefined) return undefined;
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return typeof scripts["dev"] === "string"
      ? "dev"
      : typeof scripts["start"] === "string"
        ? "start"
        : undefined;
  } catch {
    return undefined;
  }
};

/** How a lockfile's package manager installs it (its setup) and calls its scripts (its run). */
const MANAGERS = [
  { when: "bun.lockb", installs: "bun install", call: "bun run" },
  { when: "bun.lock", installs: "bun install", call: "bun run" },
  { when: "pnpm-lock.yaml", installs: "pnpm install", call: "pnpm run" },
  { when: "package-lock.json", installs: "npm install", call: "npm run" },
] as const;

/**
 * Setup and run as the project's package manager and files guess them: yarn installs by its name
 * alone, a node project without a lockfile by npm; `uv sync` serves python, a rust project builds,
 * and Go runs no install of its own.
 */
export const guessScripts = (names: ReadonlyArray<string>, packageJson?: string): ScriptFile => {
  const run = packageRun(packageJson);
  for (const manager of MANAGERS) {
    if (!names.includes(manager.when)) continue;
    return { setup: manager.installs, ...(run === undefined ? {} : { run: `${manager.call} ${run}` }) };
  }
  if (names.includes("yarn.lock"))
    return { setup: "yarn", ...(run === undefined ? {} : { run: `yarn ${run}` }) };
  if (names.includes("uv.lock") || names.includes("pyproject.toml")) return { setup: "uv sync" };
  if (names.includes("Cargo.toml")) return { setup: "cargo build", run: "cargo run" };
  if (names.includes("go.mod")) return { setup: "go mod download", run: "go run ." };
  if (names.includes("package.json")) {
    if (run === undefined) return { setup: "npm install" };
    return { setup: "npm install", run: `npm run ${run}` };
  }
  return {};
};

/** How one command resolves: the user's saved word for the field, then the file's, then the guess.
 * A saved empty string is the user turning a command off: it stands over the file's and the guess. */
const oneOf = (
  saved: string | null,
  file: string | undefined,
  guess: string | undefined,
): ResolvedScript | undefined =>
  saved === null
    ? file !== undefined
      ? { text: file, from: "project" }
      : guess === undefined
        ? undefined
        : { text: guess, from: "guessed" }
    : saved === ""
      ? undefined
      : { text: saved, from: "saved" };

const sameFolder = (
  path: { readonly resolve: (folder: string) => string },
  a: string,
  b: string,
): boolean => {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return left === right || (process.platform === "win32" && left.toLowerCase() === right.toLowerCase());
};

const exists = (file: string) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const host: ShellHost = { platform: process.platform, env: process.env, exists };

/** The one implementation the orchestrator's layer consumes and the UI's RPC goes through. */
export const projectScriptsLayer = Layer.effect(
  ProjectScripts,
  Effect.gen(function* () {
    const store = yield* Store;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const terminals = yield* Terminals;
    const scope = yield* Scope.Scope;

    const ended = yield* PubSub.unbounded<ScriptEnded>();
    /** The runs watched for their end, keyed by the terminal they run in. */
    const waiting = new Map<string, Omit<ScriptEnded, "code">>();

    // A terminal's list tells when a run ended (its exit code) or stopped (it's gone, no code):
    // both reach the thread, so its lead knows when the server is there and when it fell over.
    yield* terminals.changes.pipe(
      Stream.runForEach((all) =>
        Effect.sync(() => {
          for (const info of all) {
            const one = waiting.get(info.id);
            if (one === undefined) continue;
            if (info.exitCode !== undefined) {
              waiting.delete(info.id);
              PubSub.publishUnsafe(ended, { ...one, code: info.exitCode });
            }
          }
          for (const [id, one] of [...waiting]) {
            if (!all.some((info) => info.id === id)) {
              waiting.delete(id);
              PubSub.publishUnsafe(ended, { ...one, code: undefined });
            }
          }
        }),
      ),
      Effect.forkIn(scope),
    );

    const resolve = Effect.fn("ProjectScripts.resolve")(function* (project: string) {
      const folder = path.resolve(project);
      const names = yield* fs
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const fileOption = yield* Effect.option(fs.readFileString(path.join(folder, SCRIPT_FILE)));
      const file = Option.isSome(fileOption) ? scriptsFromToml(fileOption.value) : ({} as ScriptFile);
      const packageJson = Option.getOrUndefined(
        yield* Effect.option(fs.readFileString(path.join(folder, "package.json"))),
      );
      const guess = guessScripts(names, packageJson);
      const where = (yield* store.listProjects.pipe(
        Effect.mapError(
          (error) => new ScriptsError({ message: `The projects couldn't be read: ${error.message}` }),
        ),
      )).find((each) => sameFolder(path, each.path, project));
      const setup = oneOf(where?.setup ?? null, file.setup, guess.setup);
      const run = oneOf(where?.run ?? null, file.run, guess.run);
      return {
        ...(setup === undefined ? {} : { setup }),
        ...(run === undefined ? {} : { run }),
      } satisfies ResolvedScripts;
    });

    return ProjectScripts.of({
      resolve,

      start: Effect.fn("ProjectScripts.start")(function* (options: {
        kind: ScriptKind;
        threadId: ThreadId;
        project: string;
        cwd: string;
        size?: { readonly cols: number; readonly rows: number };
        auto?: boolean;
      }) {
        const { kind, threadId, project, cwd, size, auto } = options;
        const one = (yield* resolve(project))?.[kind] as ResolvedScript | undefined;
        // A guess is run only when the user themselves stands behind it; the thread was just told.
        if (auto === true && one?.from === "guessed")
          return { _tag: "Guess", script: one!.text } satisfies ScriptStarted;
        if (one === undefined) {
          return auto === true
            ? undefined
            : yield* new ScriptsError({
                message: `No ${kind} command is set for ${path.basename(project)}; set one in Settings → Source control.`,
              });
        }
        const started = yield* terminals
          .openScript(
            threadId,
            SCRIPT_LABEL[kind],
            scriptChoice(chooseShell(host), one.text),
            cwd,
            size ?? SCRIPT_SIZE,
          )
          .pipe(
            Effect.mapError(
              (error) => new ScriptsError({ message: `The ${kind} couldn't start: ${error.message}` }),
            ),
          );
        waiting.set(started.id, { threadId, kind, script: one.text });
        return { _tag: "Ran", script: one.text, from: one.from } satisfies ScriptStarted;
      }),
      ended: Stream.fromPubSub(ended),
    });
  }),
);
