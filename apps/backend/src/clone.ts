import type { CloneEvent, GitError } from "@cerium/rpc";
import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git } from "./git.ts";

// Cloning a repository into a folder the user picks, and making a folder a repository. Git does the
// work; these functions decide what Cerium asks git for and say, in plain words, what went wrong.

/** A request to clone or initialise a repository the backend refused; `message` is written for the user. */
export class RepositoryError extends Schema.TaggedError<RepositoryError>()("RepositoryError", {
  message: Schema.String,
}) {}

/** The web and remote-shell addresses git can clone from. Local paths and `ext::` helpers are refused. */
const SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);

/**
 * `user@host:path`, the address form git's SSH shorthand takes. A user or host that starts with a dash
 * would read as an option to `ssh`, so neither may.
 */
const SCP_LIKE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*:[^\s]+$/;

/** A character no folder name can hold on Windows, besides the separators. */
// The control characters are the point of the pattern.
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_IN_NAME = /[<>:"|?*\\/\u0000-\u001f]/;

/**
 * Why `url` can't be cloned, written for the user; undefined when it can. Only the schemes and
 * SSH shorthand listed here are accepted: git's other transports can run commands or read local files.
 */
export const refuseCloneUrl = (url: string): string | undefined => {
  const text = url.trim();
  if (text === "" || /\s/.test(text) || text.startsWith("-")) return "That isn't a repository address.";
  if (SCP_LIKE.test(text)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "That isn't a repository address.";
  }
  if (!SCHEMES.has(parsed.protocol)) return "Cerium clones over https, http, ssh or git addresses.";
  // A host that starts with a dash would read as an option to `ssh`.
  if (parsed.hostname === "" || parsed.hostname.startsWith("-")) return "That isn't a repository address.";
  return undefined;
};

/** The folder name git gives a clone of `url`: its last path segment without `.git`; undefined when that isn't a usable name. */
export const repositoryName = (url: string): string | undefined => {
  const text = url.trim();
  // A URL's path, or an SSH shorthand's `host:path`, without its trailing slashes.
  let path: string;
  try {
    path = new URL(text).pathname;
  } catch {
    path = text.slice(text.indexOf(":") + 1);
  }
  const segment = path.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const name = segment.replace(/\.git$/i, "");
  if (name === "" || name === "." || name === ".." || FORBIDDEN_IN_NAME.test(name)) return undefined;
  if (/[. ]$/.test(name)) return undefined;
  return name;
};

/**
 * What to tell the user about a clone or init git couldn't finish, from git's own complaint (its
 * stderr). Falls back to git's last `fatal:` line when none of the common cases match.
 */
export const plainGitFailure = (stderr: string, fallback: string): string => {
  const text = stderr.toLowerCase();
  if (/could not resolve host|name or service not known|temporary failure in name resolution/.test(text))
    return "Git couldn't find that address. Check the URL and your connection.";
  if (/connection timed out|operation timed out|connection refused/.test(text))
    return "Git couldn't reach that address in time. Check your connection and try again.";
  if (
    /authentication failed|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey\)/.test(
      text,
    )
  )
    return "That repository needs a sign-in Git couldn't get. Sign in with your git credential helper or `gh auth login`, then try again.";
  if (/repository .* not found|does not appear to be a git repository/.test(text))
    return "There's no repository at that address, or it's private and Git isn't signed in to it.";
  if (/already exists and is not an empty directory/.test(text))
    return "That folder already holds something. Pick an empty folder or another name.";
  if (/permission denied|unable to create|read-only file system/.test(text))
    return "Git couldn't write to that folder.";
  const fatal = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("fatal:") || line.startsWith("error:"));
  return fatal === undefined ? fallback : fatal.replace(/^(fatal|error):\s*/, "");
};

const SPAWN_FAILURE = "Cerium couldn't run git. Is it installed and on the PATH?";

export class Repositories extends Context.Service<
  Repositories,
  {
    /**
     * Clones `url` into a new folder named after it, inside `folder`. Git's progress streams as it runs;
     * the last event names the folder made, or the stream fails with what went wrong.
     */
    clone(url: string, folder: string): Stream.Stream<CloneEvent, RepositoryError>;
    /** Makes `root` a git repository, as `git init` does. */
    init(root: string): Effect.Effect<void, RepositoryError | GitError>;
  }
>()("cerium/backend/Repositories") {
  /** Requires `FileSystem`, `Path`, `ChildProcessSpawner` and `Git`. */
  static readonly layer = Layer.effect(
    Repositories,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const repos = yield* Git;

      /** `folder` as a directory, or the refusal to say why it isn't one. */
      const directory = Effect.fn("Repositories.directory")(function* (folder: string) {
        const base = path.resolve(folder);
        const info = yield* fs
          .stat(base)
          .pipe(Effect.mapError(() => new RepositoryError({ message: "That folder is gone." })));
        if (info.type !== "Directory") return yield* new RepositoryError({ message: "That isn't a folder." });
        return base;
      });

      /** Whether `target` can take a clone: absent, or an empty folder (git's own rule). */
      const free = Effect.fn("Repositories.free")(function* (target: string) {
        const info = yield* Effect.option(fs.stat(target));
        if (Option.isNone(info)) return true;
        if (info.value.type !== "Directory") return false;
        const names = yield* fs
          .readDirectory(target)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => ["?"]));
        return names.length === 0;
      });

      const clone = (url: string, parent: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const refusal = refuseCloneUrl(url);
            if (refusal !== undefined) return yield* new RepositoryError({ message: refusal });
            const name = repositoryName(url);
            if (name === undefined)
              return yield* new RepositoryError({
                message: "Cerium couldn't name a folder for that address.",
              });
            const base = yield* directory(parent);
            const target = path.join(base, name);
            if (!(yield* free(target)))
              return yield* new RepositoryError({
                message: `${name} is already in that folder and isn't empty. Pick another folder.`,
              });
            // The process lives as long as the stream: dropping the stream stops the clone.
            const handle = yield* spawner
              .spawn(
                ChildProcess.make("git", ["clone", "--progress", "--", url, target], {
                  cwd: base,
                  env: { GIT_TERMINAL_PROMPT: "0" },
                  extendEnv: true,
                  stdin: "ignore",
                }),
              )
              .pipe(Effect.mapError(() => new RepositoryError({ message: SPAWN_FAILURE })));
            // Git writes its progress to stderr, a carriage return a line, so a line may come in pieces.
            const complaints = yield* Ref.make("");
            const progress = Stream.decodeText(handle.stderr).pipe(
              Stream.mapError(() => new RepositoryError({ message: "Git's output couldn't be read." })),
              Stream.tap((text) => Ref.update(complaints, (all) => all + text)),
              Stream.flatMap((text) => Stream.fromIterable(text.split(/[\r\n]+/))),
              Stream.map((line) => line.trim()),
              Stream.filter((line) => line !== ""),
              Stream.map((text): CloneEvent => ({ _tag: "Progress", text })),
            );
            const finished = Stream.fromEffect(
              Effect.gen(function* () {
                const code = Number(
                  yield* handle.exitCode.pipe(
                    Effect.mapError(() => new RepositoryError({ message: SPAWN_FAILURE })),
                  ),
                );
                if (code === 0) return { _tag: "Cloned", path: target } satisfies CloneEvent;
                return yield* new RepositoryError({
                  message: plainGitFailure(yield* Ref.get(complaints), "The clone didn't finish."),
                });
              }),
            );
            return Stream.concat(progress, finished);
          }),
        );

      const init = Effect.fn("Repositories.init")(function* (root: string) {
        const base = yield* directory(root);
        yield* repos.change(base, ["init", "--quiet"], {
          fallback: "Git couldn't make that folder a repository.",
        });
        // The folder was not a repository a moment ago: the next look finds the new one.
        yield* repos.forget(base);
      });

      return Repositories.of({ clone, init });
    }),
  );
}
