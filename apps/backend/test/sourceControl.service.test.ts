import { Checkpoints, Orchestrator, ProjectScripts, Worktrees } from "@cerium/orchestrator";
import { type AgentId, type AgentInfo, type ThreadId, type ThreadInfo } from "@cerium/protocol";
import { GitError, GitHubError } from "@cerium/rpc";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Git } from "../src/git.ts";
import { GitBranches } from "../src/gitBranches.ts";
import { GitChanges } from "../src/gitChanges.ts";
import { GitHub } from "../src/github.ts";
import { SourceControl } from "../src/sourceControl.ts";
import { checkoutId } from "../src/worktree.ts";
import { sameCheckout as samePath } from "../src/checkouts.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const git = yield* Git;
  const command = (args: ReadonlyArray<string>) =>
    git
      .run(root, args)
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(new GitError({ message: result.stderr })),
        ),
      );
  yield* command(["init", "-q", "-b", "main"]);
  yield* command(["config", "user.name", "Test"]);
  yield* command(["config", "user.email", "test@example.invalid"]);
  yield* command(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
  const id = "thr_source" as ThreadId;
  const agentId = "agt_source" as AgentId;
  const thread: ThreadInfo = {
    id,
    cwd: root,
    mode: "work",
    title: "Workspace test",
    createdAt: 0,
    updatedAt: 0,
  };
  const lead: AgentInfo = {
    id: agentId,
    threadId: id,
    role: "lead",
    provider: "claude",
    model: "opus",
    access: "auto",
    state: "idle",
    createdAt: 0,
    updatedAt: 0,
  };
  const notices: Array<string> = [];
  let pull = {
    url: "https://github.com/example/repo/pull/1",
    title: "Test change",
    state: "OPEN",
    headRefOid: "abc",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [],
    comments: [],
    reviews: [],
  };
  let available = false;
  const layers = Layer.mergeAll(
    Layer.succeed(Orchestrator, {
      listThreads: Effect.succeed([thread]),
      threadOverviews: Effect.succeed([{ thread, agents: [lead], awaitingApproval: false }]),
      watchThreadOverviews: Stream.empty,
      agent: () => Effect.succeed(lead),
      listAgents: () => Effect.succeed([lead]),
      wake: (_id: AgentId, text: string) =>
        Effect.sync(() => {
          notices.push(text);
        }),
      notify: (_id: AgentId, text: string) =>
        Effect.sync(() => {
          notices.push(text);
        }),
    } as unknown as Orchestrator["Service"]),
    Layer.succeed(Store, {
      getThread: () => Effect.succeedSome(thread),
      listEvents: () => Effect.succeed([]),
    } as unknown as Store["Service"]),
    Layer.succeed(GitHub, {
      repository: () =>
        Effect.succeed({ host: "github.com", owner: "example", name: "repo", viewer: "owner" }),
      gh: () =>
        Effect.suspend(() =>
          available
            ? Effect.succeed(JSON.stringify(pull))
            : Effect.fail(new GitHubError({ reason: "notFound", message: "No PR for this branch." })),
        ),
    } as unknown as GitHub["Service"]),
    Layer.succeed(ProjectScripts, {
      ended: Stream.empty,
      status: () => Effect.succeed(undefined),
    } as unknown as ProjectScripts["Service"]),
    Worktrees.unavailable,
    Checkpoints.unavailable,
    GitBranches.layer,
    GitChanges.layer,
  );
  const layer = SourceControl.layer({ file: `${root}/state/links.json` }).pipe(Layer.provide(layers));
  const context = yield* Layer.build(layer);
  return {
    root,
    fs,
    command,
    thread,
    lead,
    id,
    agentId,
    notices,
    control: Context.get(context, SourceControl),
    layer,
    setAvailable: () => {
      available = true;
    },
    setPull: (state: string) => {
      pull = { ...pull, state };
    },
  };
});

const Base = Git.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe("source control workspace service", () => {
  it.effect("retains managed workspace inventory when the last conversation moves away", () =>
    Effect.gen(function* () {
      const { control, id, root, command, thread, layer } = yield* fixture;
      const target = `${root}/isolated`;
      const head = yield* command(["rev-parse", "HEAD"]);
      yield* command(["worktree", "add", "-b", "cerium/isolated", target, "HEAD"]);
      Object.assign(thread, {
        cwd: target,
        worktree: {
          id: checkoutId(target),
          managed: true,
          project: root,
          root: target,
          branch: "cerium/isolated",
          base: "main",
          baseCommit: head,
        },
      });
      yield* control.run(id, { action: "status" });
      Object.assign(thread, { cwd: root });
      Reflect.deleteProperty(thread, "worktree");
      const restored = Context.get(yield* Layer.build(Layer.fresh(layer)), SourceControl);
      const list = yield* restored.run(id, { action: "list" });
      assert.isTrue(list.checkouts?.find((checkout) => samePath(checkout.path, target))?.managed);
      const removed = yield* restored.run(id, { action: "cleanup", targetPath: target });
      assert.include(removed.note, "Removed the clean workspace");
    }).pipe(Effect.scoped, Effect.provide(Base)),
  );
  it.effect("reads real Git changes and discovers the checkout independently of a thread", () =>
    Effect.gen(function* () {
      const { control, id, fs, root } = yield* fixture;
      yield* fs.writeFileString(`${root}/new file.txt`, "Untracked work\n");
      const status = yield* control.run(id, { action: "status" });
      assert.strictEqual(status.snapshot?.branch, "main");
      assert.strictEqual(status.snapshot?.unstaged, 1);
      assert.strictEqual(status.snapshot?.nextAction, "Review and commit");
      assert.strictEqual((yield* control.run(id, { action: "list" })).checkouts?.length, 1);
      const clean = yield* Effect.exit(control.run(id, { action: "cleanup", targetPath: root }));
      assert.isTrue(clean._tag === "Failure");
    }).pipe(Effect.scoped, Effect.provide(Base)),
  );

  it.effect("persists PR links, exposes reverse links and keeps an explicit unlink from rediscovery", () =>
    Effect.gen(function* () {
      const { control, id, root, setAvailable, layer } = yield* fixture;
      setAvailable();
      const url = "https://github.com/example/repo/pull/1";
      yield* control.run(id, { action: "link", url });
      assert.strictEqual((yield* control.related(url))[0]?.id, id);
      const restored = Context.get(yield* Layer.build(Layer.fresh(layer)), SourceControl);
      assert.strictEqual((yield* restored.run(id, { action: "status" })).snapshot?.pulls[0]?.url, url);
      yield* restored.run(id, { action: "unlink", url });
      assert.deepStrictEqual(yield* restored.related(url), []);
      const status = yield* restored.run(id, { action: "status" });
      assert.deepStrictEqual(status.snapshot?.pulls, []);
      assert.isTrue(yield* (yield* FileSystem.FileSystem).exists(`${root}/state/links.json`));
    }).pipe(Effect.scoped, Effect.provide(Base)),
  );

  it.effect("refuses foreign PR URLs and mutations from a read-only agent", () =>
    Effect.gen(function* () {
      const { control, id, lead, agentId } = yield* fixture;
      const foreign = yield* Effect.exit(
        control.run(id, { action: "link", url: "https://github.com/other/repo/pull/1" }),
      );
      assert.isTrue(foreign._tag === "Failure");
      Object.assign(lead, { access: "readOnly" });
      const refused = yield* Effect.exit(
        control.agent(agentId, { action: "watch", url: "https://github.com/example/repo/pull/1" }),
      );
      assert.isTrue(refused._tag === "Failure");
    }).pipe(Effect.scoped, Effect.provide(Base)),
  );

  it.effect("watches without blocking a turn and reports a terminal PR change once", () =>
    Effect.gen(function* () {
      const { control, id, notices, setAvailable, setPull } = yield* fixture;
      setAvailable();
      const url = "https://github.com/example/repo/pull/1";
      yield* control.run(id, { action: "watch", url });
      assert.strictEqual(notices.length, 0);
      setPull("MERGED");
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(notices.length, 1);
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(notices.length, 1);
      assert.strictEqual((yield* control.run(id, { action: "status" })).snapshot?.pulls[0]?.watching, false);
    }).pipe(Effect.scoped, Effect.provide(Base)),
  );
});
