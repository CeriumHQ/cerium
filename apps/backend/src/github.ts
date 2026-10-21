import { classifyVersion, parseVersion } from "@cerium/harness";
import {
  GitHubError,
  type GitHubAccount,
  type GitHubErrorReason,
  type GitHubLoginProgress,
  type GitHubRepository,
  type GitHubStatus,
  type MergeMethod,
  type RepositoryPermission,
} from "@cerium/rpc";
import { Cache, Context, Effect, Exit, Layer, Option, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { json, text } from "./githubConversation.ts";

// GitHub through the user's own `gh`: where it's installed and whether it's signed in, the repository
// a folder's remotes name, and `gh api` for everything else. `gh` keeps its credential and Cerium never
// reads it: what `gh auth status` says is the account's name and nothing more. Fetches and pushes go
// through git, whose own credential helper answers them.

/** The `gh` versions Cerium is tested with. Older ones lack none of what it uses, but aren't tried. */
export const GH_VERSION = { minimum: "2.40.0", testedMaximum: "2.102.0" } as const;

export const GH_INSTALL_URL = "https://cli.github.com";

/** The host a repository is on unless its remote says another. */
export const DEFAULT_HOST = "github.com";

/** How long one `gh` may take before it counts as GitHub not answering. */
const GH_TIMEOUT = "60 seconds";

/** What every `gh` and `git` Cerium runs is told: nothing to prompt for, no colours, no update notices. */
const QUIET_ENV: Record<string, string | undefined> = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  GH_PAGER: "",
  GH_FORCE_TTY: undefined,
  NO_COLOR: "1",
  CLICOLOR: "0",
  GIT_TERMINAL_PROMPT: "0",
};

// ---------------------------------------------------------------------------------------------
// Remotes

/** A repository a remote's address names. */
export interface RemoteRepository {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/**
 * The GitHub repository a git remote's address names: `https://github.com/o/r(.git)`,
 * `git@github.com:o/r.git`, `ssh://git@ssh.github.com:443/o/r.git` and the like. Undefined for an
 * address that names no `owner/name` on a host.
 */
export const parseRemoteUrl = (address: string): RemoteRepository | undefined => {
  const trimmed = address.trim();
  // scp-like: user@host:owner/name
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)\/?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  let host: string | undefined;
  let path: string | undefined;
  if (scp && !/^[a-z][\w+.-]*:\/\//i.test(trimmed)) {
    host = scp[1];
    path = `${scp[2]}/${scp[3]}`;
  } else {
    try {
      const url = new URL(trimmed);
      if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(url.protocol))
        return undefined;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  }
  const parts = (path ?? "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  if (host === undefined || parts.length !== 2 || parts.some((part) => part === "")) return undefined;
  const lower = host.toLowerCase();
  // GitHub's SSH over port 443 answers for github.com.
  const normal = lower === "ssh.github.com" || lower === "www.github.com" ? DEFAULT_HOST : lower;
  return { host: normal, owner: parts[0]!, name: parts[1]! };
};

/** Whether a remote's host is GitHub's or a GitHub Enterprise one, as far as its name tells. */
export const isGitHubHost = (host: string) =>
  host === DEFAULT_HOST || host.endsWith(".ghe.com") || host.includes("github");

export interface Remote {
  readonly name: string;
  readonly repository: RemoteRepository;
}

/** The GitHub remotes `git remote -v` lists, each once, by where it fetches from. */
export const parseRemotes = (output: string): ReadonlyArray<Remote> => {
  const remotes: Array<Remote> = [];
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line.trim());
    if (match === null || remotes.some((remote) => remote.name === match[1])) continue;
    const repository = parseRemoteUrl(match[2]!);
    if (repository !== undefined && isGitHubHost(repository.host)) {
      remotes.push({ name: match[1]!, repository });
    }
  }
  return remotes;
};

/** Remotes by how likely each is the repository the work is for, as `gh` itself picks them. */
const REMOTE_ORDER = ["upstream", "github", "origin"];

/**
 * Which remote names the repository and which the user pushes to. `resolved` is what
 * `gh repo set-default` keeps (`remote.<name>.gh-resolved`): `base` marks a remote as the
 * repository, `owner/name` names one.
 */
export const chooseRemotes = (
  remotes: ReadonlyArray<Remote>,
  resolved: ReadonlyMap<string, string>,
): { readonly base: Remote; readonly push: Remote; readonly chosen: boolean } | undefined => {
  if (remotes.length === 0) return undefined;
  const named = (name: string) => remotes.find((remote) => remote.name === name);
  const push = named("origin") ?? remotes[0]!;
  for (const [name, value] of resolved) {
    const remote = named(name);
    if (remote === undefined) continue;
    if (value === "base") return { base: remote, push, chosen: true };
    const [owner, repo] = value.split("/");
    if (owner !== undefined && repo !== undefined) {
      return {
        base: { name, repository: { host: remote.repository.host, owner, name: repo } },
        push,
        chosen: true,
      };
    }
  }
  const base = REMOTE_ORDER.map(named).find((remote) => remote !== undefined) ?? remotes[0]!;
  return { base, push, chosen: false };
};

/** The remotes `gh repo set-default` resolved, from `git config --get-regexp`'s lines. */
export const parseResolved = (output: string): ReadonlyMap<string, string> =>
  new Map(
    output.split("\n").flatMap((line): ReadonlyArray<[string, string]> => {
      const match = /^remote\.(.+)\.gh-resolved\s+(\S+)\s*$/.exec(line.trim());
      return match === null ? [] : [[match[1]!, match[2]!]];
    }),
  );

// ---------------------------------------------------------------------------------------------
// `gh`'s own output

/** `text` as JSON; undefined when it isn't. */
export const parseJson = (output: string): unknown => {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
};

/** The accounts `gh auth status --json hosts` lists. */
export const parseAuthStatus = (output: string): ReadonlyArray<GitHubAccount> => {
  const hosts = json(json(parseJson(output))?.["hosts"]) ?? {};
  return Object.entries(hosts).flatMap(([host, entries]) =>
    (Array.isArray(entries) ? entries : []).flatMap((entry): ReadonlyArray<GitHubAccount> => {
      const each = json(entry);
      const login = text(each?.["login"]);
      if (login === undefined || login === "") return [];
      const state = text(each?.["state"]);
      return [
        {
          host: text(each?.["host"]) ?? host,
          login,
          active: each?.["active"] === true,
          ...(state === undefined || state === "success" ? {} : { failing: true }),
        },
      ];
    }),
  );
};

/** The accounts `gh auth status` describes in words, for a `gh` too old for `--json`. */
export const parseAuthText = (output: string): ReadonlyArray<GitHubAccount> => {
  const accounts: Array<GitHubAccount> = [];
  for (const line of output.split("\n")) {
    const ok = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line);
    const failed = /Failed to log in to (\S+) (?:account|using token) ?(\S*)/.exec(line);
    const match = ok ?? failed;
    if (match === null) continue;
    const login = match[2]?.replace(/[()]/g, "") ?? "";
    accounts.push({
      host: match[1]!,
      login: login === "" ? "unknown" : login,
      active: accounts.every((account) => account.host !== match[1]),
      ...(failed === null ? {} : { failing: true }),
    });
  }
  return accounts;
};

/** The one-time code and page `gh auth login --web` printed, once it has printed both. */
export const loginPrompt = (output: string): { readonly code: string; readonly url: string } | undefined => {
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
  const url = /(https?:\/\/\S+\/login\/device\S*)/.exec(output)?.[1];
  return code === undefined || url === undefined ? undefined : { code, url };
};

/** What `gh api` printed of GitHub's own complaint, from the JSON of a REST or GraphQL answer. */
const complaintIn = (stdout: string): { readonly message?: string; readonly type?: string } => {
  const body = json(parseJson(stdout));
  const errors = Array.isArray(body?.["errors"]) ? (body["errors"] as ReadonlyArray<unknown>) : [];
  const first = json(errors[0]);
  const details = errors
    .map((each) => text(json(each)?.["message"]))
    .filter((each): each is string => each !== undefined && each !== "");
  const message = text(body?.["message"]);
  const type = text(first?.["type"]);
  const said = [message, ...details].filter((each) => each !== undefined && each !== "").join(": ");
  return { ...(said === "" ? {} : { message: said }), ...(type === undefined ? {} : { type }) };
};

const OFFLINE =
  /no such host|dial tcp|connection refused|network is unreachable|i\/o timeout|TLS handshake timeout|error connecting to|could not resolve host|EAI_AGAIN|ENOTFOUND|ECONNRESET/i;

/** `gh`'s complaint as an error in plain words, by what the user can do about it. */
export const ghFailure = (stderr: string, stdout = ""): GitHubError => {
  const { message: said, type } = complaintIn(stdout);
  const raw = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = raw.at(-1)?.replace(/^gh:\s*/, "") ?? "";
  const all = `${stderr}\n${said ?? ""}`;
  const error = (reason: GitHubErrorReason, message: string) => new GitHubError({ reason, message });
  if (/gh auth login|not logged in|HTTP 401|Bad credentials|authentication token|GH_TOKEN/i.test(all))
    return error("signedOut", "GitHub CLI isn't signed in. Sign in to GitHub in Settings → GitHub.");
  if (type === "RATE_LIMITED" || /rate limit/i.test(all) || /HTTP 429/.test(all))
    return error("rateLimited", "GitHub's rate limit is used up for now. Try again in a few minutes.");
  if (OFFLINE.test(all)) return error("offline", "GitHub can't be reached. Check the connection.");
  if (type === "NOT_FOUND" || /HTTP 404|Could not resolve to/i.test(all))
    return error("notFound", "GitHub has no such repository, or this account can't see it.");
  const message = said ?? last;
  return error("failed", message === "" ? "GitHub CLI didn't say what went wrong." : message);
};

// ---------------------------------------------------------------------------------------------

const PERMISSIONS: Readonly<Record<string, RepositoryPermission>> = {
  READ: "read",
  TRIAGE: "triage",
  WRITE: "write",
  MAINTAIN: "maintain",
  ADMIN: "admin",
};

const REPOSITORY_FIELDS = `owner { login } name url isFork isPrivate hasIssuesEnabled viewerPermission
  defaultBranchRef { name } mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge`;

const REPOSITORY_QUERY = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) { ${REPOSITORY_FIELDS} parent { ${REPOSITORY_FIELDS} } }
}`;

/** A repository's answer to `REPOSITORY_QUERY`, as `GitHubRepository` holds it. */
export const repositoryOf = (
  host: string,
  node: unknown,
  viewer: string,
): Omit<GitHubRepository, "fork"> | undefined => {
  const repository = json(node);
  const owner = text(json(repository?.["owner"])?.["login"]);
  const name = text(repository?.["name"]);
  if (owner === undefined || name === undefined) return undefined;
  const methods: ReadonlyArray<readonly [MergeMethod, string]> = [
    ["merge", "mergeCommitAllowed"],
    ["squash", "squashMergeAllowed"],
    ["rebase", "rebaseMergeAllowed"],
  ];
  return {
    host,
    owner,
    name,
    url: text(repository?.["url"]) ?? `https://${host}/${owner}/${name}`,
    defaultBranch: text(json(repository?.["defaultBranchRef"])?.["name"]) ?? "main",
    viewer,
    permission: PERMISSIONS[text(repository?.["viewerPermission"]) ?? ""] ?? "none",
    mergeMethods: methods.flatMap(([method, field]) => (repository?.[field] === true ? [method] : [])),
    deleteBranchOnMerge: repository?.["deleteBranchOnMerge"] === true,
    hasIssues: repository?.["hasIssuesEnabled"] !== false,
    private: repository?.["isPrivate"] === true,
  };
};

/** What a program printed, and how it exited. */
export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** A value of a GraphQL query's variables. */
export type Variable = string | number | boolean | null | ReadonlyArray<string>;

export class GitHub extends Context.Service<
  GitHub,
  {
    /** `gh` on this machine, and who it's signed in as. */
    readonly status: Effect.Effect<GitHubStatus>;
    /** `gh auth login --web` on `host`, until it signs in; dropping the stream cancels it. */
    login(host?: string): Stream.Stream<GitHubLoginProgress, GitHubError>;
    /** The GitHub repository `cwd`'s remotes name, the parent of a fork; read again after a while. */
    repository(cwd: string): Effect.Effect<GitHubRepository, GitHubError>;
    /** A GraphQL query's `data`, on `host`. */
    graphql(
      host: string,
      query: string,
      variables: Readonly<Record<string, Variable>>,
    ): Effect.Effect<unknown, GitHubError>;
    /** A REST call on `host` (`path` as `repos/o/r/...`); its JSON answer, undefined when empty. */
    rest(
      host: string,
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Effect.Effect<unknown, GitHubError>;
    /** Runs `gh` itself in `cwd`, failing with its complaint; for what `gh api` can't do, like `pr checkout`. */
    gh(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitHubError>;
    /** Runs git in `cwd`, as `gh` sees it: nothing waits on a terminal. */
    git(cwd: string, args: ReadonlyArray<string>): Effect.Effect<RunResult, GitHubError>;
  }
>()("cerium/backend/GitHub") {
  /** Requires `ChildProcessSpawner`. */
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const windows = process.platform === "win32";

      const missing = () =>
        new GitHubError({
          reason: "missing",
          message: "GitHub CLI isn't installed. Install it from cli.github.com.",
        });

      /** Runs `command` and collects what it printed; `stdin` is written to it when given. */
      const spawn = (
        command: string,
        args: ReadonlyArray<string>,
        options: { readonly cwd?: string; readonly stdin?: string } = {},
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                env: QUIET_ENV,
                extendEnv: true,
                stdin:
                  options.stdin === undefined
                    ? "ignore"
                    : Stream.succeed(new TextEncoder().encode(options.stdin)),
              }),
            );
            const [stdout, stderr] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: 2 },
            );
            return { stdout, stderr, code: Number(yield* handle.exitCode) } satisfies RunResult;
          }),
        );

      /** Where `gh` is installed, looked for again a minute later (or at once after it wasn't found). */
      const executables = yield* Cache.makeWith(
        (program: "gh") =>
          spawn(windows ? "where" : "which", [program]).pipe(
            Effect.map(({ stdout, code }) => {
              const found = stdout
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== "");
              // `where` lists every match; the shims beside a real `gh.exe` don't run here.
              const path = windows ? found.find((line) => /\.exe$/i.test(line)) : found[0];
              return code === 0 && path !== undefined ? Option.some(path) : Option.none<string>();
            }),
            Effect.orElseSucceed(() => Option.none<string>()),
          ),
        {
          capacity: 1,
          timeToLive: (exit) =>
            Exit.isSuccess(exit) && Option.isSome(exit.value) ? "1 minute" : "5 seconds",
        },
      );

      const executable = Cache.get(executables, "gh").pipe(
        Effect.flatMap((found) => Effect.fromOption(found, missing)),
      );

      /** Runs `gh` and returns what it printed, whatever its exit. */
      const runGh = (
        args: ReadonlyArray<string>,
        options: { readonly cwd?: string; readonly stdin?: string } = {},
      ) =>
        Effect.gen(function* () {
          const path = yield* executable;
          return yield* spawn(path, args, options).pipe(
            Effect.timeout(GH_TIMEOUT),
            Effect.mapError(
              (cause) =>
                new GitHubError(
                  cause._tag === "TimeoutError"
                    ? { reason: "offline", message: "GitHub didn't answer in time." }
                    : { reason: "failed", message: "Cerium couldn't run GitHub CLI." },
                ),
            ),
          );
        });

      const status = Effect.gen(function* () {
        const found = yield* Cache.get(executables, "gh");
        if (Option.isNone(found))
          return { _tag: "GhMissing", installUrl: GH_INSTALL_URL } satisfies GitHubStatus;
        const versionOutput = yield* runGh(["--version"]);
        const version = parseVersion(versionOutput.stdout) ?? "unknown";
        const asJson = yield* runGh(["auth", "status", "--json", "hosts"]);
        const accounts =
          asJson.code === 0 && asJson.stdout.trim().startsWith("{")
            ? parseAuthStatus(asJson.stdout)
            : yield* runGh(["auth", "status"]).pipe(
                Effect.map(({ stdout, stderr }) => parseAuthText(`${stdout}\n${stderr}`)),
              );
        return {
          _tag: "GhInstalled",
          executablePath: found.value,
          version,
          versionStatus: version === "unknown" ? "untested" : classifyVersion(version, GH_VERSION),
          accounts,
        } satisfies GitHubStatus;
      }).pipe(Effect.orElseSucceed((): GitHubStatus => ({ _tag: "GhMissing", installUrl: GH_INSTALL_URL })));

      const login = (host: string = DEFAULT_HOST) =>
        Stream.callback<GitHubLoginProgress, GitHubError>((queue) =>
          Effect.gen(function* () {
            const path = yield* executable;
            const handle = yield* spawner
              .spawn(
                ChildProcess.make(path, ["auth", "login", "--web", "--hostname", host], {
                  env: QUIET_ENV,
                  extendEnv: true,
                  stdin: "ignore",
                }),
              )
              .pipe(
                Effect.mapError(
                  () => new GitHubError({ reason: "failed", message: "Cerium couldn't run GitHub CLI." }),
                ),
              );
            let printed = "";
            let told = false;
            const watch = Stream.decodeText(handle.stderr).pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  printed += chunk;
                  const prompt = told ? undefined : loginPrompt(printed);
                  if (prompt === undefined) return;
                  told = true;
                  Queue.offerUnsafe(queue, { _tag: "Code", ...prompt });
                }),
              ),
            );
            const code = yield* Effect.all([watch, Stream.runDrain(handle.stdout)], { concurrency: 2 }).pipe(
              Effect.andThen(handle.exitCode),
              Effect.mapError(
                () => new GitHubError({ reason: "failed", message: "GitHub sign-in stopped." }),
              ),
            );
            if (Number(code) !== 0) return yield* Queue.fail(queue, ghFailure(printed));
            yield* Queue.offer(queue, { _tag: "SignedIn" });
            yield* Queue.end(queue);
          }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
        );

      const graphql = (host: string, query: string, variables: Readonly<Record<string, Variable>>) =>
        Effect.gen(function* () {
          const { stdout, stderr, code } = yield* runGh(
            ["api", "graphql", "--hostname", host, "--input", "-"],
            {
              stdin: JSON.stringify({ query, variables }),
            },
          );
          const parsed = parseJson(stdout);
          if (parsed === undefined) return yield* ghFailure(stderr, stdout);
          const data = json(parsed)?.["data"];
          const errors = json(parsed)?.["errors"];
          const answered = Object.values(json(data) ?? {}).some((value) => value !== null);
          // An answer with some of its fields refused still answers the rest.
          if ((code !== 0 || (Array.isArray(errors) && errors.length > 0)) && !answered) {
            return yield* ghFailure(stderr, stdout);
          }
          return data;
        });

      const rest = (
        host: string,
        method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
      ) =>
        Effect.gen(function* () {
          const { stdout, stderr, code } = yield* runGh(
            [
              "api",
              "--hostname",
              host,
              "--method",
              method,
              "-H",
              "Accept: application/vnd.github+json",
              path,
              ...(body === undefined ? [] : ["--input", "-"]),
            ],
            body === undefined ? {} : { stdin: JSON.stringify(body) },
          );
          if (code !== 0) return yield* ghFailure(stderr, stdout);
          return stdout.trim() === "" ? undefined : (parseJson(stdout) ?? stdout);
        });

      const gh = (cwd: string, args: ReadonlyArray<string>) =>
        runGh(args, { cwd }).pipe(
          Effect.flatMap(({ stdout, stderr, code }) =>
            code === 0 ? Effect.succeed(stdout) : Effect.fail(ghFailure(stderr, stdout)),
          ),
        );

      const git = (cwd: string, args: ReadonlyArray<string>) =>
        spawn("git", args, { cwd }).pipe(
          Effect.timeout(GH_TIMEOUT),
          Effect.mapError(
            () => new GitHubError({ reason: "failed", message: "Cerium couldn't run git. Is it installed?" }),
          ),
        );

      const findRepository = (cwd: string) =>
        Effect.gen(function* () {
          const listed = yield* git(cwd, ["remote", "-v"]);
          if (listed.code !== 0) {
            return yield* new GitHubError({
              reason: "noRepository",
              message: "This folder isn't in a git repository.",
            });
          }
          const remotes = parseRemotes(listed.stdout);
          const resolved = yield* git(cwd, ["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]);
          const choice = chooseRemotes(remotes, parseResolved(resolved.stdout));
          if (choice === undefined) {
            return yield* new GitHubError({
              reason: "noRepository",
              message: "This repository has no GitHub remote.",
            });
          }
          const { base, push, chosen } = choice;
          const data = json(
            yield* graphql(base.repository.host, REPOSITORY_QUERY, {
              owner: base.repository.owner,
              name: base.repository.name,
            }),
          );
          const viewer = text(json(data?.["viewer"])?.["login"]) ?? "";
          const node = json(data?.["repository"]);
          const own = repositoryOf(base.repository.host, node, viewer);
          if (own === undefined) {
            return yield* new GitHubError({
              reason: "notFound",
              message: `GitHub has no repository ${base.repository.owner}/${base.repository.name}, or this account can't see it.`,
            });
          }
          // A fork's pull requests and issues are its parent's, unless the user chose the fork itself.
          const parent = repositoryOf(base.repository.host, node?.["parent"], viewer);
          if (!chosen && node?.["isFork"] === true && parent !== undefined) {
            return { ...parent, fork: `${own.owner}/${own.name}` } satisfies GitHubRepository;
          }
          const pushed = push.repository;
          const pushesElsewhere =
            pushed.owner.toLowerCase() !== own.owner.toLowerCase() ||
            pushed.name.toLowerCase() !== own.name.toLowerCase();
          return {
            ...own,
            ...(pushesElsewhere ? { fork: `${pushed.owner}/${pushed.name}` } : {}),
          } satisfies GitHubRepository;
        });

      const repositories = yield* Cache.makeWith(findRepository, {
        capacity: 32,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "2 minutes" : "3 seconds"),
      });

      return GitHub.of({
        status,
        login,
        repository: (cwd) => Cache.get(repositories, cwd),
        graphql,
        rest,
        gh,
        git,
      });
    }),
  );
}
