import {
  ProjectScripts,
  ScriptsError,
  type ResolvedAction,
  type ResolvedScript,
  type ResolvedScripts,
  type ScriptEnded,
  type ScriptKind,
  type ScriptServed,
  type ScriptStarted,
  type ScriptStatus,
  type TeardownFailure,
} from "@cerium/orchestrator";
import { ThreadId } from "@cerium/protocol";
import { actionListProblem, actionNameProblem } from "@cerium/rpc";
import { Store } from "@cerium/store";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { lstatSync } from "node:fs";

import { editProjectFile, ProjectFileError, readProjectFile } from "./projectToml.ts";
import { tailOf } from "./pushModel.ts";
import { Terminals } from "./terminal.ts";
import { chooseShell, inheritedEnv, scriptChoice, taskkillArgs, type ShellHost } from "./terminalShell.ts";
import { PORT_BLOCK, ThreadEnv } from "./threadEnv.ts";

// What each project's worktree is made usable with: the setup command that runs as the worktree is
// made — the user's saved word for the project wins, then the project's own `.cerium.toml`, then a
// guess from its package manager that waits for the user — and the run command that keeps it going,
// whose output's dev-server address the terminal hands over. Scripts run in a terminal of the
// thread's own, where the user and its agents watch them. A third, teardown, runs out of sight as
// the thread's worktree is removed, to stop what setup or run started outside it. A project also has
// named commands, its actions (Test, Lint, Migrate): the user's saved list when they have one, else
// the project's `[actions]`, run on demand in a terminal labelled with the name, and never guessed.

/** The project's own file, checked into the repository so a team shares one set of commands. */
const SCRIPT_FILE = ".cerium.toml";

/** The size a script's terminal starts at; its viewer fits it again. */
const SCRIPT_SIZE = { cols: 100, rows: 30 };

/** What a terminal's tab shows for the script it runs; a plain shell's tab shows its shell's name. */
export const SCRIPT_LABEL = { setup: "Setup", run: "Run" } as const;

/** How much of a failed script's last output its end carries to the lead: lines, and characters at most. */
const ENDED_LINES = 30;
const ENDED_CHARS = 3_000;
/** The most characters of output a status holds, whatever lines were asked for. */
const STATUS_CHARS = 8_000;

/** How long a teardown may run before it is stopped and the thread is put away without it. */
export const TEARDOWN_LIMIT_SECONDS = 60;

/** What `[scripts]` of a `.cerium.toml` holds. */
export interface ScriptFile {
  readonly setup?: string;
  readonly run?: string;
  readonly teardown?: string;
}

/**
 * The scripts a `.cerium.toml` holds, in its `[scripts]` section, quoted plainly or with single
 * quotes, its comments dropped. What the file holds elsewhere is left as its own: the fields get
 * commands, and nothing else of the file is Cerium's to read (`projectToml.ts`).
 */
export const scriptsFromToml = (text: string): ScriptFile => {
  const { scripts } = readProjectFile(text);
  return {
    ...(scripts["setup"] === undefined ? {} : { setup: scripts["setup"] }),
    ...(scripts["run"] === undefined ? {} : { run: scripts["run"] }),
    ...(scripts["teardown"] === undefined ? {} : { teardown: scripts["teardown"] }),
  };
};

/**
 * The actions of a list that can be told apart and run: a name another action has already (ignoring
 * case) or that a script of the project has is left out, and so is one with no command.
 */
export const usableActions = <A extends { readonly name: string }>(
  actions: ReadonlyArray<A>,
  hasCommand: (action: A) => boolean,
): ReadonlyArray<A> => {
  const kept: A[] = [];
  for (const action of actions) {
    if (!hasCommand(action)) continue;
    if (
      actionNameProblem(
        action.name,
        kept.map((each) => each.name),
      ) === undefined
    )
      kept.push(action);
  }
  return kept;
};

/** The end of a script's output as one line for the user: its last few lines, without colour codes. */
export const outputTail = (output: string): string => {
  const lines = output
    // oxlint-disable-next-line no-control-regex
    .replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tail = lines.slice(-3).join(" · ");
  return tail.length > 300 ? `…${tail.slice(-300)}` : tail;
};

/** Why a teardown failed, in a line: what happened to it, then what it last said. */
export const teardownFailure = (
  how: { readonly code: number } | { readonly timedOut: true } | { readonly cannotStart: string },
  output: string,
): string => {
  const what =
    "timedOut" in how
      ? `ran longer than ${TEARDOWN_LIMIT_SECONDS} seconds and was stopped`
      : "cannotStart" in how
        ? `couldn't start: ${how.cannotStart}`
        : `exited with code ${how.code}`;
  const tail = outputTail(output);
  return tail === "" ? what : `${what}: ${tail}`;
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
    const threads = yield* ThreadEnv;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Scope.Scope;

    const ended = yield* PubSub.unbounded<ScriptEnded>();
    const served = yield* PubSub.unbounded<ScriptServed>();
    /** The runs watched for their end, keyed by the terminal they run in. */
    const waiting = new Map<string, Omit<ScriptEnded, "code" | "output">>();
    /** The runs a caller waits on for the first news of them, which the caller takes instead of the lead. */
    const claims = new Map<string, Deferred.Deferred<void>>();

    /** Hands the first news of a run to the caller waiting for it; whether there was one. */
    const settle = (id: string): boolean => {
      const claim = claims.get(id);
      if (claim === undefined) return false;
      claims.delete(id);
      Deferred.doneUnsafe(claim, Effect.void);
      return true;
    };

    /** A thread's own terminal for `kind`: the newest, when a replaced one has lingered. */
    const terminalOf = (threadId: ThreadId, kind: ScriptKind) =>
      Effect.map(terminals.list, (all) =>
        all.findLast((info) => info.threadId === threadId && info.script === SCRIPT_LABEL[kind]),
      );

    // A terminal's list tells when a run ended (its exit code) or stopped (it's gone, no code):
    // both reach the thread, so its lead knows when the server is there and when it fell over, and
    // why, from the last of what a failed script printed.
    yield* terminals.changes.pipe(
      Stream.runForEach((all) =>
        Effect.gen(function* () {
          for (const info of all) {
            const one = waiting.get(info.id);
            if (one === undefined || info.exitCode === undefined) continue;
            waiting.delete(info.id);
            if (settle(info.id)) continue;
            const printed =
              info.exitCode === 0
                ? undefined
                : yield* terminals.output(info.id, ENDED_LINES).pipe(
                    Effect.map(({ text }) => tailOf(text.trim(), ENDED_CHARS)),
                    Effect.orElseSucceed(() => ""),
                  );
            PubSub.publishUnsafe(ended, {
              ...one,
              code: info.exitCode,
              ...(printed ? { output: printed } : {}),
            });
          }
          // Who's gone is read from the terminals as they are now: this list may be older than a run
          // started while a failed script's output was being read.
          const present = yield* terminals.list;
          for (const [id, one] of [...waiting]) {
            if (!present.some((info) => info.id === id)) {
              waiting.delete(id);
              if (!settle(id)) PubSub.publishUnsafe(ended, { ...one, code: undefined });
            }
          }
        }),
      ),
      Effect.forkIn(scope),
    );

    // A run's first local address tells the lead where the project is serving, once per run.
    yield* terminals.served.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          const one = waiting.get(event.id);
          if (one === undefined || one.kind !== "run" || settle(event.id)) return;
          PubSub.publishUnsafe(served, { ...one, url: event.url });
        }),
      ),
      Effect.forkIn(scope),
    );

    /** What offers a project its commands: its file, the guess from its folder, and the user's saved ones. */
    const offers = Effect.fn("ProjectScripts.offers")(function* (project: string) {
      const folder = path.resolve(project);
      const names = yield* fs
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const fileOption = yield* Effect.option(fs.readFileString(path.join(folder, SCRIPT_FILE)));
      const file = Option.isSome(fileOption)
        ? readProjectFile(fileOption.value)
        : ({ scripts: {}, actions: [] } satisfies ReturnType<typeof readProjectFile>);
      const packageJson = Option.getOrUndefined(
        yield* Effect.option(fs.readFileString(path.join(folder, "package.json"))),
      );
      const guess = guessScripts(names, packageJson);
      const where = (yield* store.listProjects.pipe(
        Effect.mapError(
          (error) => new ScriptsError({ message: `The projects couldn't be read: ${error.message}` }),
        ),
      )).find((each) => sameFolder(path, each.path, project));
      return { file, guess, where };
    });

    const resolve = Effect.fn("ProjectScripts.resolve")(function* (project: string) {
      const { file, guess, where } = yield* offers(project);
      const setup = oneOf(where?.setup ?? null, file.scripts["setup"], guess.setup);
      const run = oneOf(where?.run ?? null, file.scripts["run"], guess.run);
      // Nothing guesses a teardown: it only ever runs on the user's word, saved or in the file.
      const teardown = oneOf(where?.teardown ?? null, file.scripts["teardown"], undefined);
      // The user's own list replaces the file's whole, so a project's actions come from one side.
      const actions: ReadonlyArray<ResolvedAction> =
        where?.actions == null
          ? usableActions(file.actions, (action) => action.command.trim() !== "").map((action) => ({
              name: action.name,
              text: action.command,
              from: "project" as const,
            }))
          : usableActions(where.actions, (action) => action.command.trim() !== "").map((action) => ({
              name: action.name.trim(),
              text: action.command,
              from: "saved" as const,
            }));
      return {
        ...(setup === undefined ? {} : { setup }),
        ...(run === undefined ? {} : { run }),
        ...(teardown === undefined ? {} : { teardown }),
        // An empty list is there when the user's own is: they turned the file's actions off.
        ...(actions.length === 0 && where?.actions == null ? {} : { actions }),
      } satisfies ResolvedScripts;
    });

    const writeFile = Effect.fn("ProjectScripts.writeFile")(function* (options: {
      project: string;
      setup: string;
      run: string;
      teardown?: string;
      actions: ReadonlyArray<{ readonly name: string; readonly command: string }>;
    }) {
      const problem = actionListProblem(options.actions);
      if (problem !== undefined) return yield* new ScriptsError({ message: problem });
      const file = path.join(path.resolve(options.project), SCRIPT_FILE);
      const failed = (what: string) => (error: { readonly message: string }) =>
        new ScriptsError({ message: `${SCRIPT_FILE} couldn't be ${what}: ${error.message}` });
      const text = (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
        ? yield* fs.readFileString(file).pipe(Effect.mapError(failed("read")))
        : "";
      const setup = options.setup.trim();
      const run = options.run.trim();
      const teardown = options.teardown?.trim();
      const edited = yield* Effect.try({
        try: () =>
          editProjectFile(text, {
            scripts: {
              setup: setup === "" ? null : setup,
              run: run === "" ? null : run,
              ...(teardown === undefined ? {} : { teardown: teardown === "" ? null : teardown }),
            },
            actions: options.actions
              .filter((action) => action.command.trim() !== "")
              .map((action) => ({ name: action.name.trim(), command: action.command.trim() })),
          }),
        catch: (error) =>
          new ScriptsError({
            message: error instanceof ProjectFileError ? error.message : `${SCRIPT_FILE} couldn't be edited.`,
          }),
      });
      if (edited !== text) yield* fs.writeFileString(file, edited).pipe(Effect.mapError(failed("written")));
      // The file now says what the user sees, so nothing saved here is left to shadow it, except a
      // command emptied that the project's guess would bring back: that stays turned off. Teardown is
      // never guessed, so a written one clears what was saved outright.
      const { guess } = yield* offers(options.project);
      yield* store
        .writeProjectScripts(options.project, {
          setup: setup === "" && guess.setup !== undefined ? "" : null,
          run: run === "" && guess.run !== undefined ? "" : null,
          ...(teardown === undefined ? {} : { teardown: null }),
          actions: null,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ScriptsError({ message: `The project's commands couldn't be saved: ${error.message}` }),
          ),
        );
    });

    /** Ends a process and what it started: a shell's children outlive it on Windows otherwise. */
    const stopTree = (pid: number) =>
      process.platform === "win32"
        ? spawner
            .spawn(
              ChildProcess.make("taskkill", taskkillArgs(pid), {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            )
            .pipe(
              Effect.andThen((handle) => handle.exitCode),
              Effect.scoped,
              Effect.ignore,
            )
        : Effect.void;

    /** Runs `command` to its end, out of sight, with what it printed; stopped at the time limit. */
    const runHidden = Effect.fn("ProjectScripts.runHidden")(function* (
      command: string,
      cwd: string,
      threadEnv: Readonly<Record<string, string>>,
    ) {
      const shell = scriptChoice(chooseShell(host), command);
      const ran = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(shell.file, shell.args, {
              cwd,
              env: { ...inheritedEnv(process.env), ...threadEnv },
              extendEnv: false,
              stdin: "ignore",
            }),
          );
          // What the shell started outlives it when it is stopped; the tree goes with the scope.
          yield* Effect.addFinalizer(() =>
            handle.isRunning.pipe(
              Effect.flatMap((running) => (running ? stopTree(Number(handle.pid)) : Effect.void)),
              Effect.ignore,
            ),
          );
          const output = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(handle.all)));
          const code = Number(yield* handle.exitCode);
          return { code, output: yield* Fiber.join(output) };
        }),
      );
      return yield* ran.pipe(
        Effect.map((done) => ({ _tag: "Ended", ...done }) as const),
        Effect.timeoutOrElse({
          duration: Duration.seconds(TEARDOWN_LIMIT_SECONDS),
          orElse: () => Effect.succeed({ _tag: "TimedOut" } as const),
        }),
      );
    });

    return ProjectScripts.of({
      resolve,

      teardown: Effect.fn("ProjectScripts.teardown")(function* (options: {
        threadId: ThreadId;
        project: string;
        cwd: string;
      }) {
        const { threadId, project, cwd } = options;
        const scripts = yield* resolve(project).pipe(Effect.orElseSucceed((): ResolvedScripts => ({})));
        const one = scripts.teardown;
        if (one === undefined) return undefined;
        // A worktree already gone has nothing left to tear down.
        if (!(yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) return undefined;
        const threadEnv = yield* threads.of(threadId);
        const result = yield* runHidden(one.text, cwd, threadEnv).pipe(
          Effect.catch((error: { readonly message?: string }) =>
            Effect.succeed({
              _tag: "CannotStart",
              message: error.message ?? "the shell wouldn't start",
            } as const),
          ),
        );
        if (result._tag === "Ended" && result.code === 0) return undefined;
        const how =
          result._tag === "TimedOut"
            ? ({ timedOut: true } as const)
            : result._tag === "CannotStart"
              ? ({ cannotStart: result.message } as const)
              : ({ code: result.code } as const);
        return {
          script: one.text,
          failure: teardownFailure(how, result._tag === "Ended" ? result.output : ""),
        } satisfies TeardownFailure;
      }),

      ports: Effect.fn("ProjectScripts.ports")(function* (threadId: ThreadId) {
        const first = yield* threads.port(threadId);
        return first === undefined ? undefined : { first, last: first + PORT_BLOCK - 1 };
      }),

      start: Effect.fn("ProjectScripts.start")(function* (options: {
        kind: ScriptKind;
        threadId: ThreadId;
        project: string;
        cwd: string;
        size?: { readonly cols: number; readonly rows: number };
        auto?: boolean;
        settleWithin?: Duration.Input;
      }) {
        const { kind, threadId, project, cwd, size, auto, settleWithin } = options;
        const one = (yield* resolve(project))?.[kind] as ResolvedScript | undefined;
        // A guess is run only when the user themselves stands behind it; the thread was just told.
        if (auto === true && one?.from === "guessed")
          return { _tag: "Guess", script: one!.text } satisfies ScriptStarted;
        if (one === undefined) {
          return auto === true
            ? undefined
            : yield* new ScriptsError({
                message: `No ${kind} command is set for ${path.basename(project)}; set one in Settings → Git & GitHub.`,
              });
        }
        // The run this one replaces is over by the user's or an agent's own doing: its closing isn't
        // news, and nobody is left waiting on it.
        for (const [id, earlier] of [...waiting]) {
          if (earlier.threadId !== threadId || earlier.kind !== kind) continue;
          waiting.delete(id);
          settle(id);
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
        if (settleWithin !== undefined) {
          const claim = yield* Deferred.make<void>();
          claims.set(started.id, claim);
          // Its first news arrives here if it comes in time; later, the thread's lead hears it.
          // A caller that gives up (its tool call was cancelled) leaves no claim to swallow the news.
          yield* Deferred.await(claim).pipe(
            Effect.timeoutOrElse({ duration: settleWithin, orElse: () => Effect.void }),
            Effect.ensuring(
              Effect.sync(() => {
                if (claims.get(started.id) === claim) claims.delete(started.id);
              }),
            ),
          );
        }
        return { _tag: "Ran", script: one.text, from: one.from } satisfies ScriptStarted;
      }),
      stop: Effect.fn("ProjectScripts.stop")(function* (threadId: ThreadId, kind: ScriptKind) {
        const own = yield* terminalOf(threadId, kind);
        if (own === undefined) return false;
        waiting.delete(own.id);
        settle(own.id);
        yield* terminals.close(own.id).pipe(Effect.ignore);
        return true;
      }),
      status: Effect.fn("ProjectScripts.status")(function* (
        threadId: ThreadId,
        kind: ScriptKind,
        lines: number,
      ) {
        const own = yield* terminalOf(threadId, kind);
        if (own === undefined) return undefined;
        const printed = yield* terminals.output(own.id, lines).pipe(Effect.option);
        if (Option.isNone(printed)) return undefined;
        return {
          running: own.exitCode === undefined,
          ...(own.exitCode === undefined ? {} : { exitCode: own.exitCode }),
          ...(printed.value.url === undefined ? {} : { url: printed.value.url }),
          output: tailOf(printed.value.text, STATUS_CHARS),
        } satisfies ScriptStatus;
      }),

      startAction: Effect.fn("ProjectScripts.startAction")(function* (options: {
        name: string;
        threadId: ThreadId;
        project: string;
        cwd: string;
        size?: { readonly cols: number; readonly rows: number };
      }) {
        const { name, threadId, project, cwd, size } = options;
        const wanted = name.trim().toLowerCase();
        const action = (yield* resolve(project)).actions?.find((each) => each.name.toLowerCase() === wanted);
        if (action === undefined) {
          return yield* new ScriptsError({
            message: `${path.basename(project)} has no ${name.trim()} action; add one in Settings → Git & GitHub.`,
          });
        }
        yield* terminals
          .openScript(
            threadId,
            action.name,
            scriptChoice(chooseShell(host), action.text),
            cwd,
            size ?? SCRIPT_SIZE,
          )
          .pipe(
            Effect.mapError(
              (error) => new ScriptsError({ message: `${action.name} couldn't start: ${error.message}` }),
            ),
          );
        return action;
      }),
      writeFile,
      ended: Stream.fromPubSub(ended),
      served: Stream.fromPubSub(served),
    });
  }),
);
