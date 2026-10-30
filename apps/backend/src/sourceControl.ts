import { SourceControlHost } from "@cerium/bus";
import {
  Checkpoints,
  Orchestrator,
  OrchestratorError,
  ProjectScripts,
  Worktrees,
} from "@cerium/orchestrator";
import {
  PullRequestLink,
  ThreadWorktree,
  type AgentId,
  type SourceControlCommand,
  type SourceControlResult,
  type SourceControlSnapshot,
  type ThreadId,
} from "@cerium/protocol";
import { Store } from "@cerium/store";
import {
  Context,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { Git } from "./git.ts";
import { GitChanges } from "./gitChanges.ts";
import { GitBranches } from "./gitBranches.ts";
import { GitHub } from "./github.ts";
import { checkoutId } from "./worktree.ts";
import { parseCheckouts, sameCheckout, insideCheckout } from "./checkouts.ts";
import { Terminals } from "./terminal.ts";

const SavedLink = Schema.Struct({
  root: Schema.String,
  url: Schema.String,
  threadId: Schema.String,
  watching: Schema.Boolean,
  fingerprint: Schema.String,
  value: PullRequestLink,
  kind: Schema.optionalKey(Schema.Literals(["pull", "issue"])),
  unlinked: Schema.optionalKey(Schema.Boolean),
});
type SavedLink = typeof SavedLink.Type;
const Saved = Schema.Union([
  Schema.Array(SavedLink),
  Schema.Struct({ links: Schema.Array(SavedLink), workspaces: Schema.Array(ThreadWorktree) }),
]);
const Pull = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  headRefOid: Schema.String,
  mergeable: Schema.String,
  reviewDecision: Schema.NullOr(Schema.String),
  statusCheckRollup: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        conclusion: Schema.optionalKey(Schema.String),
        state: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  comments: Schema.Array(
    Schema.Struct({ id: Schema.String, author: Schema.NullOr(Schema.Struct({ login: Schema.String })) }),
  ),
  reviews: Schema.Array(
    Schema.Struct({ id: Schema.String, author: Schema.NullOr(Schema.Struct({ login: Schema.String })) }),
  ),
});

const fail = (message: string) => new OrchestratorError({ reason: "invalid", message });
const refuse = (error: { readonly message: string }) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

/** Links and watches belong to conversations, while Git remains the checkout inventory. */
export class SourceControl extends Context.Service<
  SourceControl,
  {
    readonly related: (
      url: string,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly title: string; readonly active: boolean }>,
      OrchestratorError
    >;
    readonly run: (
      threadId: ThreadId,
      command: SourceControlCommand,
    ) => Effect.Effect<SourceControlResult, OrchestratorError>;
    readonly agent: (
      agentId: AgentId,
      command: SourceControlCommand,
    ) => Effect.Effect<SourceControlResult, OrchestratorError>;
  }
>()("cerium/backend/SourceControl") {
  static readonly host = Layer.effect(
    SourceControlHost,
    Effect.map(SourceControl, (service) => SourceControlHost.of({ run: service.agent })),
  );

  static readonly layer = (options: { readonly file: string }) =>
    Layer.effect(
      SourceControl,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const git = yield* Git;
        const changes = yield* GitChanges;
        const branches = yield* GitBranches;
        const github = yield* GitHub;
        const store = yield* Store;
        const orchestrator = yield* Orchestrator;
        const worktrees = yield* Worktrees;
        const scripts = yield* ProjectScripts;
        const checkpoints = yield* Checkpoints;
        const terminals = yield* Effect.serviceOption(Terminals);
        const lock = yield* Semaphore.make(1);
        const monitors = yield* FiberMap.make<string>();
        const preparing = new Map<ThreadId, string>();
        // Adopt legacy thread-owned checkouts without moving files or changing branches.
        for (const thread of yield* orchestrator.listThreads) {
          if (thread.worktree && !thread.worktree.id)
            yield* store.updateThread(thread.id, {
              worktree: { ...thread.worktree, id: checkoutId(thread.worktree.root), managed: true },
            });
        }
        const discovered = new Map<ThreadId, number>();
        const refreshedLinks = new Map<string, number>();
        yield* Stream.runForEach(scripts.ended, (event) =>
          Effect.sync(() => {
            if (event.kind === "setup")
              preparing.set(
                event.threadId,
                event.code === 0
                  ? "Ready"
                  : `Setup failed${event.code === undefined ? " or stopped" : ` (exit ${event.code})`}. Open its terminal or retry setup.`,
              );
          }),
        ).pipe(Effect.forkScoped);
        let links: Array<SavedLink> = [];
        const inventory = new Map<string, ThreadWorktree>();
        if (yield* fs.exists(options.file)) {
          const saved = yield* fs
            .readFileString(options.file)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Saved))));
          if ("links" in saved) {
            links = [...saved.links];
            for (const workspace of saved.workspaces)
              if (workspace.id) inventory.set(workspace.id, workspace);
          } else links = [...saved];
        }
        const save = Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(options.file), { recursive: true });
          yield* fs.writeFileString(
            `${options.file}.tmp`,
            JSON.stringify({ links, workspaces: [...inventory.values()] }),
          );
          yield* fs.rename(`${options.file}.tmp`, options.file);
        });
        const remember = (workspace: ThreadWorktree | undefined) => {
          if (!workspace?.id || JSON.stringify(inventory.get(workspace.id)) === JSON.stringify(workspace))
            return false;
          inventory.set(workspace.id, workspace);
          return true;
        };
        yield* Stream.runForEach(orchestrator.watchThreadOverviews, (update) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              let changed = false;
              for (const overview of update.threads) changed = remember(overview.thread.worktree) || changed;
              if (changed) yield* save;
            }),
          ),
        ).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Couldn't retain workspace inventory", cause)),
          Effect.forkScoped,
        );
        const readGit = Effect.fn("SourceControl.readGit")(function* (
          root: string,
          args: ReadonlyArray<string>,
        ) {
          const result = yield* git.run(root, args, { look: true, limit: 1024 * 1024 });
          if (result.code !== 0) return yield* fail(result.stderr || "Git couldn't read this checkout.");
          return result.stdout.trim();
        });
        const threadOf = Effect.fn("SourceControl.threadOf")(function* (threadId: ThreadId) {
          const thread = Option.getOrUndefined(yield* store.getThread(threadId));
          if (thread?.cwd === undefined) return yield* fail("Choose a work thread with a repository first.");
          return { ...thread, cwd: thread.cwd };
        });
        const pullRead = Effect.fn("SourceControl.pullRead")(function* (
          root: string,
          url: string,
          issue = false,
        ) {
          const repository = yield* github.repository(root);
          const parsed = yield* Effect.try({
            try: () => new URL(url),
            catch: () => fail("Enter a complete pull request URL."),
          });
          const match = (
            issue ? /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/ : /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/
          ).exec(parsed.pathname);
          if (
            parsed.protocol !== "https:" ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash ||
            parsed.host !== repository.host ||
            match?.[1]?.toLowerCase() !== repository.owner.toLowerCase() ||
            match[2]?.toLowerCase() !== repository.name.toLowerCase()
          )
            return yield* fail("Choose a pull request in this checkout's GitHub repository.");
          if (issue) {
            const raw = yield* github.gh(root, ["issue", "view", parsed.href, "--json", "url,title,state"]);
            const item = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({ url: Schema.String, title: Schema.String, state: Schema.String }),
              ),
            )(raw);
            return {
              value: {
                ...item,
                head: "",
                watching: false,
                threadIds: [],
                checks: "none",
                review: "none",
              } satisfies PullRequestLink,
              fingerprint: JSON.stringify(item),
            };
          }
          const raw = yield* github.gh(root, [
            "pr",
            "view",
            parsed.href,
            "--json",
            "url,title,state,headRefOid,mergeable,reviewDecision,statusCheckRollup,comments,reviews",
          ]);
          const pull = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Pull))(raw);
          const checks = pull.statusCheckRollup ?? [];
          const failed = checks.some((check) =>
            ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(
              check.conclusion ?? check.state ?? "",
            ),
          );
          const pending = checks.some(
            (check) =>
              check.status === "IN_PROGRESS" || check.status === "QUEUED" || check.state === "PENDING",
          );
          return {
            value: {
              url: pull.url,
              title: pull.title,
              state: pull.state,
              head: pull.headRefOid,
              watching: false,
              threadIds: [],
              checks: failed ? "failed" : pending ? "pending" : checks.length ? "passed" : "none",
              review: pull.mergeable === "CONFLICTING" ? "conflicts" : (pull.reviewDecision ?? "none"),
            } satisfies PullRequestLink,
            fingerprint: JSON.stringify([
              pull.headRefOid,
              pull.state,
              failed,
              pending,
              pull.reviewDecision,
              pull.mergeable,
              pull.comments
                .filter((comment) => comment.author?.login !== repository.viewer)
                .map((comment) => comment.id),
              pull.reviews
                .filter((review) => review.author?.login !== repository.viewer)
                .map((review) => review.id),
            ]),
          };
        });
        const snapshot = Effect.fn("SourceControl.snapshot")(function* (
          threadId: ThreadId,
        ): Effect.fn.Return<SourceControlSnapshot, OrchestratorError> {
          const thread = yield* threadOf(threadId).pipe(Effect.mapError(refuse));
          const root =
            thread.worktree?.root ??
            (yield* readGit(thread.cwd, ["rev-parse", "--show-toplevel"]).pipe(Effect.mapError(refuse)));
          const [status, state, all] = yield* Effect.all(
            [changes.status(root), branches.state(root), orchestrator.listThreads],
            { concurrency: 3 },
          ).pipe(Effect.mapError(refuse));
          const head = yield* readGit(root, ["rev-parse", "HEAD"]).pipe(Effect.mapError(refuse));
          const baseRef = thread.worktree?.base ?? state.upstream?.name ?? state.branch ?? head;
          const baseNow = yield* git
            .run(root, ["rev-parse", "--verify", `${baseRef}^{commit}`], { look: true })
            .pipe(Effect.mapError(refuse));
          const baseCommit = thread.worktree?.baseCommit ?? baseNow.stdout.trim();
          const setup = yield* scripts.status(threadId, "setup", 0);
          if (Date.now() - (discovered.get(threadId) ?? 0) > 120000) {
            discovered.set(threadId, Date.now());
            yield* Effect.gen(function* () {
              const url =
                thread.worktree?.pullRequestUrl ??
                (yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
                )(yield* github.gh(root, ["pr", "view", "--json", "url"]))).url;
              if (links.some((link) => link.threadId === threadId && link.url === url)) return;
              const read = yield* pullRead(root, url);
              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  if (links.some((link) => link.threadId === threadId && link.url === read.value.url)) return;
                  links.push({
                    root,
                    url: read.value.url,
                    threadId,
                    watching: false,
                    fingerprint: read.fingerprint,
                    value: read.value,
                  });
                  yield* save;
                }),
              );
            }).pipe(Effect.ignore);
          }
          for (const link of links.filter(
            (link) => !link.unlinked && (link.threadId === threadId || sameCheckout(link.root, root)),
          )) {
            const key = `${checkoutId(root)}:${link.url}`;
            if (Date.now() - (refreshedLinks.get(key) ?? 0) < 30000) continue;
            refreshedLinks.set(key, Date.now());
            yield* Effect.gen(function* () {
              const current = yield* pullRead(root, link.url, link.kind === "issue");
              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  links = links.map((saved) =>
                    saved.url === link.url && sameCheckout(saved.root, root)
                      ? { ...saved, value: current.value }
                      : saved,
                  );
                  yield* save;
                }),
              );
            }).pipe(Effect.ignore);
          }
          const relevant = links.filter(
            (link) => !link.unlinked && (link.threadId === threadId || sameCheckout(link.root, root)),
          );
          const pulls = [
            ...new Set(relevant.filter((link) => link.kind !== "issue").map((link) => link.url)),
          ].map((url) => {
            const group = relevant.filter((link) => link.url === url);
            return {
              ...group[0]!.value,
              watching: group.some((link) => link.threadId === threadId && link.watching),
              threadIds: group.map((link) => link.threadId),
            };
          });
          const issues = [
            ...new Set(relevant.filter((link) => link.kind === "issue").map((link) => link.url)),
          ].map((url) => {
            const group = relevant.filter((link) => link.url === url);
            return {
              url,
              title: group[0]!.value.title,
              state: group[0]!.value.state,
              threadIds: group.map((link) => link.threadId),
            };
          });
          return {
            id: thread.worktree?.id ?? checkoutId(root),
            root,
            branch: state.branch ?? "Detached HEAD",
            head,
            baseRef,
            baseCommit,
            staged: status.staged.length,
            unstaged: status.unstaged.length,
            conflicted: status.conflicted.length,
            ahead: state.upstream?.ahead ?? 0,
            behind: state.upstream?.behind ?? 0,
            nextAction: status.conflicted.length
              ? "Resolve conflicts"
              : status.staged.length || status.unstaged.length
                ? "Review and commit"
                : (state.upstream?.ahead ?? 0) > 0
                  ? "Push commits"
                  : pulls.some((pull) => pull.state === "OPEN")
                    ? "Review pull request"
                    : "Create pull request",
            threads: all
              .filter((other) => insideCheckout(root, other.worktree?.root ?? other.cwd ?? ""))
              .map((other) => ({ id: other.id, title: other.title, active: other.archivedAt === undefined })),
            pulls,
            issues,
            preparation:
              preparing.get(threadId) ??
              (setup?.running
                ? "Setup running. Open the setup terminal for progress."
                : setup?.exitCode !== undefined && setup.exitCode !== 0
                  ? `Setup failed (exit ${setup.exitCode}). Open its terminal or retry setup.`
                  : "Ready"),
            ...(thread.worktree?.dependsOnThreadId
              ? { dependsOnThreadId: thread.worktree.dependsOnThreadId }
              : {}),
            baseMoved: baseNow.code === 0 && baseCommit !== "" && baseNow.stdout.trim() !== baseCommit,
          };
        });
        const monitor = (root: string, url: string) =>
          Effect.gen(function* () {
            let failures = 0;
            while (links.some((link) => sameCheckout(link.root, root) && link.url === url && link.watching)) {
              yield* Effect.sleep("2 minutes");
              const read = yield* pullRead(root, url).pipe(Effect.result);
              if (read._tag === "Failure") {
                failures++;
                if (failures < 8) continue;
                yield* lock.withPermits(1)(
                  Effect.gen(function* () {
                    const affected = links.filter(
                      (link) => sameCheckout(link.root, root) && link.url === url && link.watching,
                    );
                    for (const link of affected) {
                      const agents = yield* orchestrator.listAgents(link.threadId as ThreadId);
                      const lead = agents.find((agent) => agent.parentId === undefined);
                      if (lead)
                        yield* orchestrator.notify(
                          lead.id,
                          `Stopped watching ${url} after eight failed reads. Inspect GitHub and restart the watch when available.`,
                        );
                    }
                    links = links.map((link) =>
                      affected.includes(link) ? { ...link, watching: false } : link,
                    );
                    yield* save;
                  }),
                );
                return;
              }
              failures = 0;
              const current = read.success;
              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  const overviews = yield* orchestrator.threadOverviews;
                  for (const link of links.filter(
                    (link) => sameCheckout(link.root, root) && link.url === url && link.watching,
                  )) {
                    const thread = overviews.find((overview) => overview.thread.id === link.threadId);
                    const lead = thread?.agents.find((agent) => agent.parentId === undefined);
                    if (
                      !thread ||
                      thread.thread.archivedAt !== undefined ||
                      !lead ||
                      lead.state === "stopped"
                    ) {
                      links = links.map((item) => (item === link ? { ...item, watching: false } : item));
                      continue;
                    }
                    if (current.fingerprint !== link.fingerprint)
                      yield* orchestrator
                        .wake(
                          lead.id,
                          `Pull request changed: ${url}\n${current.value.title}; ${current.value.state}; checks ${current.value.checks}; review ${current.value.review}; head ${current.value.head}. Read the current PR and address the changes. Merging remains the user's decision.`,
                        )
                        .pipe(Effect.ignore);
                  }
                  links = links.map((link) =>
                    sameCheckout(link.root, root) && link.url === url
                      ? {
                          ...link,
                          value: current.value,
                          fingerprint: current.fingerprint,
                          watching: link.watching && current.value.state === "OPEN",
                        }
                      : link,
                  );
                  yield* save;
                }),
              );
            }
          }).pipe(Effect.catchCause((cause) => Effect.logWarning("PR monitor stopped", cause)));
        const startMonitor = (root: string, url: string) =>
          FiberMap.run(monitors, `${checkoutId(root)}:${url}`, monitor(root, url), { onlyIfMissing: true });

        const run = Effect.fn("SourceControl.run")(function* (
          threadId: ThreadId,
          command: SourceControlCommand,
        ) {
          const thread = yield* threadOf(threadId).pipe(Effect.mapError(refuse));
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (remember(thread.worktree)) yield* save;
            }),
          );
          const root =
            command.action === "move"
              ? (thread.worktree?.project ?? thread.cwd)
              : (thread.worktree?.root ??
                (yield* readGit(thread.cwd, ["rev-parse", "--show-toplevel"]).pipe(Effect.mapError(refuse))));
          if (command.action === "list") {
            const output = yield* readGit(root, ["worktree", "list", "--porcelain", "-z"]);
            return {
              checkouts: parseCheckouts(output, yield* orchestrator.listThreads).map((checkout) => ({
                ...checkout,
                managed: inventory.get(checkout.id)?.managed === true,
              })),
              note: "Existing checkouts and their conversations.",
            };
          }
          if (["link", "unlink", "link_issue", "unlink_issue", "watch", "unwatch"].includes(command.action)) {
            if (!command.url) return yield* fail("Choose a pull request URL.");
            const url = command.url;
            if (command.action === "link" || command.action === "link_issue" || command.action === "watch") {
              const read = yield* pullRead(root, url, command.action === "link_issue").pipe(
                Effect.mapError(refuse),
              );
              if (command.action === "watch" && read.value.state !== "OPEN")
                return yield* fail("Only open pull requests can be watched.");
              yield* lock
                .withPermits(1)(
                  Effect.gen(function* () {
                    const existing = links.find(
                      (link) => link.threadId === threadId && link.url === read.value.url,
                    );
                    links = links.filter(
                      (link) => !(link.threadId === threadId && link.url === read.value.url),
                    );
                    links.push({
                      root,
                      url: read.value.url,
                      threadId,
                      watching: command.action === "watch" || existing?.watching === true,
                      fingerprint: read.fingerprint,
                      value: read.value,
                      kind: command.action === "link_issue" ? "issue" : "pull",
                    });
                    yield* save;
                  }),
                )
                .pipe(Effect.mapError(refuse));
              if (command.action === "watch") yield* startMonitor(root, read.value.url);
            } else {
              yield* lock
                .withPermits(1)(
                  Effect.gen(function* () {
                    links = links.map((link) =>
                      link.threadId === threadId && link.url === url
                        ? {
                            ...link,
                            watching: false,
                            ...(["unlink", "unlink_issue"].includes(command.action)
                              ? { unlinked: true }
                              : {}),
                          }
                        : link,
                    );
                    yield* save;
                  }),
                )
                .pipe(Effect.mapError(refuse));
            }
            return {
              snapshot: yield* snapshot(threadId),
              note:
                command.action === "watch"
                  ? "Watching this PR. End your turn; changes arrive as notices."
                  : "Pull request links updated.",
            };
          }
          if (command.action === "retry_setup") {
            const started = yield* scripts
              .start({
                kind: "setup",
                threadId,
                project: thread.worktree?.project ?? thread.cwd,
                cwd: thread.cwd,
              })
              .pipe(Effect.mapError(refuse));
            preparing.set(
              threadId,
              started?._tag === "Ran"
                ? "Setup running. Open the setup terminal for progress."
                : "No confirmed setup command.",
            );
            return {
              note: started
                ? "Setup started. Follow its terminal for progress and errors."
                : "This project has no setup command.",
            };
          }
          if (command.action === "diff") {
            const revision = yield* readGit(root, ["rev-parse", "HEAD"]);
            if (
              command.scope === "uncommitted" ||
              command.scope === "branch" ||
              command.scope === undefined
            ) {
              const base =
                command.scope === "branch"
                  ? yield* readGit(root, [
                      "rev-parse",
                      "--verify",
                      "--end-of-options",
                      `${(yield* snapshot(threadId)).baseRef}^{commit}`,
                    ])
                  : "HEAD";
              const diff = yield* readGit(root, [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                ...(command.scope === "branch" ? [`${base}...HEAD`] : ["HEAD"]),
                "--",
              ]);
              return {
                diff,
                revision,
                note:
                  command.scope === "branch"
                    ? `Branch changes against ${base}.`
                    : "Tracked uncommitted changes, staged and unstaged. Untracked files appear in workspace status.",
              };
            }
            const agents = yield* orchestrator.listAgents(threadId);
            const events = (yield* Effect.forEach(agents, (agent) =>
              store.listEvents(agent.id, { tags: ["TurnFilesChanged"] }),
            ))
              .flat()
              .sort((a, b) => a.at - b.at);
            const turns = events.flatMap((event) =>
              event.payload._tag === "TurnFilesChanged" ? [event.payload] : [],
            );
            const selected = command.scope === "turn" ? turns.slice(-1) : turns;
            const diff = (yield* Effect.forEach(selected, (turn) =>
              Effect.forEach(turn.files, (file) =>
                checkpoints.diff(thread.cwd, turn.before, turn.after, file.path, 3),
              ),
            ))
              .flat()
              .join("\n");
            return {
              diff,
              revision,
              note: `${command.scope === "turn" ? "Latest completed turn" : "Recorded turn changes in this thread"}. Snapshot boundaries are shown in execution order; shared-checkout changes within a turn may include other writers. This view does not attribute ownership or stage files.`,
            };
          }
          if (command.action === "cleanup") {
            const target = command.targetPath;
            if (!target) return yield* fail("Choose the workspace to remove.");
            const all = yield* orchestrator.threadOverviews;
            const related = all.filter((overview) =>
              insideCheckout(target, overview.thread.worktree?.root ?? overview.thread.cwd ?? ""),
            );
            if (related.some((overview) => overview.thread.archivedAt === undefined))
              return yield* fail("Archive every conversation using this workspace before removing it.");
            const worktree = [...inventory.values()].find((workspace) =>
              sameCheckout(workspace.root, target),
            );
            if (!worktree || worktree.managed !== true || !sameCheckout(worktree.root, target))
              return yield* fail(
                "Only a Cerium-created workspace can be removed here. Imported checkouts are retained.",
              );
            if (
              Option.isSome(terminals) &&
              (yield* terminals.value.list).some((terminal) => insideCheckout(target, terminal.cwd))
            )
              return yield* fail("Close this workspace's terminals before removing it.");
            const registered = parseCheckouts(
              yield* readGit(root, ["worktree", "list", "--porcelain", "-z"]),
              [],
            );
            if (!registered.some((checkout) => sameCheckout(checkout.path, target)))
              return yield* fail("That workspace is no longer registered with Git.");
            const main = yield* readGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
            if (sameCheckout(path.dirname(main), target))
              return yield* fail("The main checkout cannot be removed.");
            const state = yield* changes.status(target).pipe(Effect.mapError(refuse));
            const ignored = yield* readGit(target, [
              "ls-files",
              "--others",
              "--ignored",
              "--exclude-standard",
            ]);
            if (state.staged.length || state.unstaged.length || state.conflicted.length || ignored)
              return yield* fail(
                "This checkout still holds local files or edits. Save or remove them before cleanup.",
              );
            const held = yield* worktrees.changes(worktree).pipe(Effect.mapError(refuse));
            if (held.unmerged)
              return yield* fail("This branch still has work beyond its base. Integrate it before cleanup.");
            yield* worktrees.remove(threadId, worktree, { keepBranch: true }).pipe(Effect.mapError(refuse));
            yield* lock.withPermits(1)(
              Effect.gen(function* () {
                inventory.delete(worktree.id!);
                yield* save;
              }),
            );
            return { note: "Removed the clean workspace. Conversation history is retained." };
          }
          if (command.action === "move") {
            if (!command.workspace) return yield* fail("Choose a new workspace or an existing checkout.");
            const choice = command.workspace;
            const overviews = yield* orchestrator.threadOverviews;
            const busy = () =>
              orchestrator.threadOverviews.pipe(
                Effect.map(
                  (all) =>
                    all
                      .find((overview) => overview.thread.id === threadId)
                      ?.agents.some((agent) => agent.state === "running" || agent.state === "queued") ??
                    false,
                ),
              );
            const overview = overviews.find((each) => each.thread.id === threadId);
            if (overview?.agents.some((agent) => agent.state === "running" || agent.state === "queued")) {
              preparing.set(threadId, "Move queued. Finish the current turn to prepare the destination.");
              yield* FiberMap.run(
                monitors,
                `move:${threadId}`,
                Effect.gen(function* () {
                  for (let attempt = 0; attempt < 1800; attempt++) {
                    yield* Effect.sleep("1 second");
                    if (yield* busy()) continue;
                    preparing.set(threadId, "Preparing destination…");
                    yield* orchestrator.moveThread(threadId, choice);
                    preparing.set(threadId, "Ready");
                    return;
                  }
                  preparing.set(threadId, "Move expired while the thread was busy. Retry when it is idle.");
                }).pipe(
                  Effect.catch((error) =>
                    Effect.sync(() => {
                      preparing.set(threadId, `Move failed: ${error.message}`);
                    }),
                  ),
                ),
                { onlyIfMissing: true },
              );
              return {
                note: "Move queued. End this turn. Local edits remain in the source checkout; committed files come from the selected base. Conversation history is preserved.",
              };
            }
            preparing.set(threadId, "Preparing destination…");
            yield* orchestrator.moveThread(threadId, choice);
            preparing.set(threadId, "Ready");
            return {
              snapshot: yield* snapshot(threadId),
              note: "Conversation moved. Local edits remain in the source checkout; the new session receives its conversation history.",
            };
          }
          return { snapshot: yield* snapshot(threadId), note: "Live workspace state." };
        }, Effect.mapError(refuse));
        for (const link of links.filter((link) => link.watching)) yield* startMonitor(link.root, link.url);
        return SourceControl.of({
          run,
          related: (url) =>
            Effect.gen(function* () {
              const ids = new Set(
                links.filter((link) => !link.unlinked && link.url === url).map((link) => link.threadId),
              );
              return (yield* orchestrator.listThreads)
                .filter((thread) => ids.has(thread.id))
                .map((thread) => ({
                  id: thread.id,
                  title: thread.title,
                  active: thread.archivedAt === undefined,
                }));
            }),
          agent: (agentId, command) =>
            Effect.gen(function* () {
              const caller = yield* orchestrator.agent(agentId);
              if (
                (caller.parentId !== undefined || caller.access === "readOnly") &&
                !["status", "list", "diff"].includes(command.action)
              )
                return yield* fail("Only a writable lead can manage workspace state and PR watches.");
              return yield* run(caller.threadId, command);
            }),
        });
      }).pipe(Effect.mapError(refuse)),
    );
}
