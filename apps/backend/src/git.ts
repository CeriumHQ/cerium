import { GitError } from "@cerium/rpc";
import { Cache, Context, Duration, Effect, Fiber, Layer, Path, Schedule, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Cerium's one way to run the user's own git: it finds the repository a folder is in, runs git there
// with nothing waiting on a terminal that isn't there, and words what went wrong for the user. Git
// keeps its own credentials and asks for them through its own helper; nothing here reads a token.
// Every feature of Source control builds on it: each runs its own commands through `run` (reads) and
// `change` (what changes the repository).

export { GitError };

/** What is read of git's output unless a command says otherwise; anything past it is dropped. */
export const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
/** What a failure keeps of git's output to show the user. */
const MAX_SHOWN_OUTPUT = 64 * 1024;
/** How long a repository's location is remembered. `forget` drops it sooner, after `git init`. */
const REPOSITORY_TTL = "15 seconds";

/** What git printed, and how it exited; `code` is -1 when the output was cut at `limit`. */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  /** Stdout went past the limit and was cut, and git was stopped. */
  readonly truncated: boolean;
}

export interface RunOptions {
  /** Written to git's stdin. */
  readonly stdin?: string;
  /**
   * Only looks: git takes none of the optional locks it would take to tidy its index, so a look
   * doesn't set off the watchers, nor get in the way of an agent's git.
   */
  readonly look?: boolean;
  /** Paths are pathspecs, with their magic (`:/`, `*`); otherwise every path is taken as written. */
  readonly pathspecs?: boolean;
  /** At most this many bytes of stdout are read (`MAX_GIT_OUTPUT` unless given). */
  readonly limit?: number;
  /** More environment for git. */
  readonly env?: Readonly<Record<string, string>>;
  /** How long git may take before it is stopped and the command fails. */
  readonly timeout?: Duration.Input;
}

export interface ChangeOptions extends RunOptions {
  /** What the failure says when git doesn't say why, as "Git couldn't stage those files." */
  readonly fallback: string;
}

/** Where a folder sits in a git repository. */
export interface Repository {
  /** The repository's top folder, as the system names it. */
  readonly top: string;
  /** The folder's path from `top`, ending with a slash; empty at the top. */
  readonly prefix: string;
  /** Git's own folder for this work tree; a worktree's is inside the main repository's. */
  readonly gitDir: string;
  /** The folder its worktrees share: refs, objects and config. The same as `gitDir` outside a worktree. */
  readonly commonDir: string;
}

// ---------------------------------------------------------------------------------------------
// Git's words

/** What git and its hooks printed, trimmed, and cut to what's worth showing. */
export const shownOutput = (result: Pick<GitResult, "stdout" | "stderr">): string => {
  const text = [result.stderr, result.stdout]
    .map((part) => part.replaceAll("\r\n", "\n").trim())
    .filter((part) => part !== "")
    .join("\n");
  return text.length > MAX_SHOWN_OUTPUT ? `${text.slice(0, MAX_SHOWN_OUTPUT)}\n…` : text;
};

/** Another git holds the index: it says so with the lock file's name, in any language. */
export const holdsIndexLock = (output: string) => /index\.lock/.test(output);

/** Git's last `fatal:` or `error:` line, without its prefix and with a capital, or undefined. */
export const gitComplaint = (output: string): string | undefined => {
  const line = output
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => /^(fatal|error):/.test(text));
  if (line === undefined) return undefined;
  const words = line.replace(/^(fatal|error):\s*/, "").replace(/\.$/, "");
  return words === "" ? undefined : `${words[0]!.toUpperCase()}${words.slice(1)}.`;
};

/**
 * What went wrong, in words for the user: what people meet most in their own words, otherwise git's
 * own complaint, or `fallback` when git said nothing that explains it.
 */
export const explainGit = (output: string, fallback: string): string => {
  const text = output.replaceAll("\r", "");
  if (holdsIndexLock(text))
    return "Another git process is working in this repository. Try again once it's done; if none is running, delete .git/index.lock.";
  if (/unable to create '[^']+\.lock'|cannot lock ref/i.test(text))
    return "Another git process is updating this repository. Try again in a moment.";
  if (/user\.email|user\.name|author identity unknown|empty ident name/i.test(text))
    return "Git doesn't know who you are yet. Set your name and email with git config --global user.name and user.email, then try again.";
  if (/not a git repository/i.test(text)) return "This folder isn't in a git repository.";
  if (/gpg failed to sign|failed to sign the data|error: (?:ssh|gpg)/i.test(text))
    return "Git couldn't sign the commit. Check your signing key, or turn commit signing off.";
  return gitComplaint(text) ?? fallback;
};

/** The failure for a git that exited with an error, with what it printed to show. */
export const gitFailure = (result: Pick<GitResult, "stdout" | "stderr">, fallback: string): GitError => {
  const output = shownOutput(result);
  return new GitError({
    message: explainGit(output, fallback),
    ...(output === "" ? {} : { output }),
  });
};

/** What `git rev-parse --is-inside-work-tree --show-toplevel --show-prefix --absolute-git-dir --git-common-dir` says. */
export const parseRepository = (
  stdout: string,
  resolve: (path: string) => string,
): Repository | undefined => {
  const [inside, top, prefix, gitDir, commonDir] = stdout.split("\n").map((line) => line.trim());
  if (inside !== "true" || !top || !gitDir) return undefined;
  return {
    top: resolve(top),
    prefix: prefix ?? "",
    gitDir: resolve(gitDir),
    // Relative to the folder asked about outside a worktree; `resolve` puts it in place.
    commonDir: resolve(commonDir || gitDir),
  };
};

// ---------------------------------------------------------------------------------------------

export class Git extends Context.Service<
  Git,
  {
    /**
     * Runs git in `cwd` and says what it printed and how it exited. Fails only when git can't run, or
     * runs past `timeout`; an exit with an error is the caller's to read.
     */
    run(cwd: string, args: ReadonlyArray<string>, options?: RunOptions): Effect.Effect<GitResult, GitError>;
    /**
     * Runs git in `cwd` to change its repository, and fails with what went wrong, worded for the
     * user, when git exits with an error. Changes to one repository take turns, and one that finds
     * another git holding the index waits a moment for it.
     */
    change(
      cwd: string,
      args: ReadonlyArray<string>,
      options: ChangeOptions,
    ): Effect.Effect<GitResult, GitError>;
    /** Where `cwd` sits in a git repository; undefined outside one, or when git isn't there. */
    repository(cwd: string): Effect.Effect<Repository | undefined>;
    /** Where `cwd` sits in a git repository, failing outside one. */
    requireRepository(cwd: string): Effect.Effect<Repository, GitError>;
    /** Forgets where `cwd` was found, after it became a repository or stopped being one. */
    forget(cwd: string): Effect.Effect<void>;
  }
>()("cerium/backend/Git") {
  /** Requires `Path` and `ChildProcessSpawner`. */
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const cannotRun = () =>
        new GitError({ message: "Cerium couldn't run git. Is it installed and on the PATH?" });

      const run = Effect.fn("Git.run")(function* (
        cwd: string,
        args: ReadonlyArray<string>,
        options: RunOptions = {},
      ) {
        const limit = options.limit ?? MAX_GIT_OUTPUT;
        const look = options.look === true;
        const command = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", [...(look ? ["--no-optional-locks"] : []), ...args], {
                cwd,
                env: {
                  GIT_TERMINAL_PROMPT: "0",
                  // Nothing opens an editor nobody would see; git keeps the message it has.
                  GIT_EDITOR: ":",
                  GIT_SEQUENCE_EDITOR: ":",
                  ...(look ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
                  ...(options.pathspecs === true ? {} : { GIT_LITERAL_PATHSPECS: "1" }),
                  ...options.env,
                },
                extendEnv: true,
                stdin:
                  options.stdin === undefined
                    ? "ignore"
                    : Stream.succeed(new TextEncoder().encode(options.stdin)),
              }),
            );
            // Stderr is read beside stdout; a git cut off mid-output never finishes it, and leaving the
            // scope stops both.
            const stderr = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(handle.stderr)));
            let size = 0;
            const chunks = yield* handle.stdout.pipe(
              Stream.takeUntil((chunk) => (size += chunk.length) >= limit),
              Stream.runCollect,
            );
            const stdout = Buffer.concat(chunks).toString("utf8");
            if (size >= limit) return { stdout, stderr: "", code: -1, truncated: true } satisfies GitResult;
            const code = Number(yield* handle.exitCode);
            return { stdout, stderr: yield* Fiber.join(stderr), code, truncated: false } satisfies GitResult;
          }),
        ).pipe(Effect.mapError(cannotRun));
        if (options.timeout === undefined) return yield* command;
        return yield* command.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              Effect.fail(
                new GitError({
                  message: `Git took longer than ${Duration.format(Duration.fromInputUnsafe(options.timeout!))} and was stopped.`,
                }),
              ),
          }),
        );
      });

      const repositories = yield* Cache.make({
        capacity: 64,
        timeToLive: REPOSITORY_TTL,
        lookup: (cwd: string) =>
          run(
            cwd,
            [
              "rev-parse",
              "--is-inside-work-tree",
              "--show-toplevel",
              "--show-prefix",
              "--absolute-git-dir",
              "--git-common-dir",
            ],
            { look: true },
          ).pipe(
            Effect.map(({ stdout, code }) =>
              code === 0 ? parseRepository(stdout, (relative) => path.resolve(cwd, relative)) : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          ),
      });

      const repository = (cwd: string) => Cache.get(repositories, path.resolve(cwd));

      const requireRepository = Effect.fn("Git.requireRepository")(function* (cwd: string) {
        const found = yield* repository(cwd);
        if (found === undefined)
          return yield* new GitError({ message: "This folder isn't in a git repository." });
        return found;
      });

      /** One turn at a time per repository's git folder, which holds its index. */
      const turns = new Map<string, Semaphore.Semaphore>();
      const turnOf = (key: string) => {
        let semaphore = turns.get(key);
        if (semaphore === undefined) {
          semaphore = Semaphore.makeUnsafe(1);
          turns.set(key, semaphore);
        }
        return semaphore;
      };

      const change = Effect.fn("Git.change")(function* (
        cwd: string,
        args: ReadonlyArray<string>,
        options: ChangeOptions,
      ) {
        const where = yield* repository(cwd);
        const attempt = run(cwd, args, options).pipe(
          Effect.filterOrFail(
            (result) => result.code === 0,
            (result) => gitFailure(result, options.fallback),
          ),
        );
        // Another git (an agent's, an editor's) holds the index for a moment at a time.
        const patient = attempt.pipe(
          Effect.retry({
            while: (error) => error.output !== undefined && holdsIndexLock(error.output),
            schedule: Schedule.spaced("250 millis"),
            times: 8,
          }),
        );
        return yield* where === undefined ? patient : turnOf(where.gitDir).withPermits(1)(patient);
      });

      return Git.of({
        run,
        change,
        repository,
        requireRepository,
        forget: (cwd) => Cache.invalidate(repositories, path.resolve(cwd)),
      });
    }),
  );
}
