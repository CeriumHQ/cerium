import { makeFakeAdapter } from "@cerium/harness/testing";
import type { HarnessAdapter } from "@cerium/harness";
import {
  Adapters,
  BusEndpoint,
  Catalog,
  Checkpoints,
  Orchestrator,
  OrchestratorConfig,
  ProjectScripts,
  UserSettings,
  Worktrees,
} from "@cerium/orchestrator";
import type { AgentEvent, AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { writeFileSync, rmSync } from "node:fs";

import { checkpointsLayer } from "../src/checkpoints.ts";
import { Git } from "../src/git.ts";
import { Terminals } from "../src/terminal.ts";
import { worktreesLayer } from "../src/worktree.ts";

const testLayer = (adapters: ReadonlyArray<HarnessAdapter>, home?: string) => {
  const terminals = Layer.succeed(Terminals, {
    closeThread: () => Effect.void,
  } as unknown as Terminals["Service"]);
  return Orchestrator.layer.pipe(
    Layer.provideMerge(UserSettings.layer),
    Layer.provideMerge(Store.layer({ filename: home === undefined ? ":memory:" : `${home}/cerium.db` })),
    Layer.provide(Adapters.fromList(adapters)),
    Layer.provide(Catalog.fromEntries([])),
    Layer.provide(
      Layer.succeed(BusEndpoint, {
        serverName: "cerium",
        register: () => Effect.succeed({ type: "http", url: "http://bus.test" }),
        unregister: () => Effect.void,
      }),
    ),
    Layer.provide(
      home === undefined ? Checkpoints.unavailable : checkpointsLayer({ directory: `${home}/snapshots` }),
    ),
    Layer.provide(
      home === undefined
        ? Worktrees.unavailable
        : worktreesLayer({ directory: `${home}/worktrees` }).pipe(
            Layer.provide(Git.layer),
            Layer.provide(terminals),
          ),
    ),
    Layer.provide(ProjectScripts.unavailable),
    Layer.provide(
      OrchestratorConfig.layer({ chatDirectory: home ?? process.cwd(), batchWindow: Duration.millis(20) }),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const recordEvents = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  const events: Array<AgentEvent> = [];
  yield* orchestrator.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
    Effect.forkScoped,
  );
  yield* Effect.sleep("5 millis");
  const waitFor = <A>(find: (events: ReadonlyArray<AgentEvent>) => A | undefined) =>
    Effect.gen(function* () {
      for (;;) {
        const found = find(events);
        if (found !== undefined) return found;
        yield* Effect.sleep("5 millis");
      }
    }).pipe(Effect.timeout("5 seconds"));
  return { waitFor };
});

describe("thread forking", () => {
  it.live("forks a native session through its selected turn while its source keeps going", () => {
    const harness = makeFakeAdapter("claude", { fork: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const original = yield* orchestrator.createThread({
        title: "Source",
        mode: "work",
        cwd: process.cwd(),
        lead: { provider: "claude", model: "original-model", access: "readOnly" },
      });
      yield* orchestrator.sendUserMessage(original.lead.id, "First request");
      const first = yield* waitFor((events) =>
        events.find((event) => event.agentId === original.lead.id && event.payload._tag === "TurnInput"),
      );
      assert(first.payload._tag === "TurnInput" && first.payload.turnId !== undefined);
      yield* waitFor((events) =>
        events.find((event) => event.agentId === original.lead.id && event.payload._tag === "TurnCompleted"),
      );
      yield* orchestrator.sendUserMessage(original.lead.id, "Later request");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.payload._tag === "MessageCompleted" && event.payload.text.includes("Later request"),
        ),
      );

      const fork = yield* orchestrator.forkThread({
        threadId: original.thread.id,
        turn: first.payload.turnId,
        model: "another-model",
      });
      assert.deepStrictEqual(fork.thread.forkedFrom, {
        threadId: original.thread.id,
        turn: first.payload.turnId,
      });
      assert.strictEqual(fork.thread.cwd, original.thread.cwd);
      assert.strictEqual(fork.lead.model, "another-model");
      assert.deepStrictEqual(harness.forks, [
        {
          cwd: process.cwd(),
          sessionId: "fake-1",
          through: { id: first.payload.turnId, index: 0 },
        },
      ]);
      yield* waitFor(() => harness.sessions.find((session) => session.options.resume === "fork-1"));
      const replies = (agentId: AgentId) =>
        store
          .listEvents(agentId, { tags: ["MessageCompleted"] })
          .pipe(
            Effect.map((events) =>
              events.flatMap(({ payload }) => (payload._tag === "MessageCompleted" ? [payload.text] : [])),
            ),
          );
      assert.deepStrictEqual(yield* replies(fork.lead.id), ["reply to: First request"]);
      assert.deepStrictEqual(yield* replies(original.lead.id), [
        "reply to: First request",
        "reply to: Later request",
      ]);
      yield* orchestrator.sendUserMessage(fork.lead.id, "Fork follow-up");
      yield* waitFor((events) =>
        events.find((event) => event.agentId === fork.lead.id && event.payload._tag === "TurnCompleted"),
      );
      assert.deepStrictEqual(yield* replies(fork.lead.id), [
        "reply to: First request",
        "reply to: Fork follow-up",
      ]);
      assert.deepStrictEqual(harness.sessions[0]?.sent, ["First request", "Later request"]);
    }).pipe(Effect.provide(testLayer([harness.adapter])));
  });

  it.live(
    "restores the selected checkpoint in a fresh worktree and briefs a different harness after restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped();
        const repo = path.join(home, "project");
        const workspace = path.join(repo, "app");
        yield* fs.makeDirectory(workspace, { recursive: true });
        const git = (...args: ReadonlyArray<string>) =>
          spawner.string(
            ChildProcess.make("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
              cwd: repo,
            }),
          );
        yield* git("init", "-q", "-b", "main");
        yield* fs.writeFileString(path.join(workspace, "keep.txt"), "base");
        yield* fs.writeFileString(path.join(workspace, "remove.txt"), "base");
        yield* git("add", "-A");
        yield* git("commit", "-qm", "Base");

        const source = makeFakeAdapter("claude", {
          reply: (text) => {
            writeFileSync(path.join(workspace, "keep.txt"), text);
            if (text === "First change") {
              rmSync(path.join(workspace, "remove.txt"));
              writeFileSync(path.join(workspace, "new.txt"), "untracked in the selected turn");
            } else {
              writeFileSync(path.join(workspace, "remove.txt"), "restored after the selected turn");
              rmSync(path.join(workspace, "new.txt"));
            }
            return `Done: ${text}`;
          },
        });
        const destination = makeFakeAdapter("codex");
        const layer = () => testLayer([source.adapter, destination.adapter], home);
        const fork = yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator;
          const { waitFor } = yield* recordEvents;
          const original = yield* orchestrator.createThread({
            title: "Source",
            mode: "work",
            cwd: workspace,
            lead: { provider: "claude", model: "source-model", access: "ask" },
          });
          yield* orchestrator.sendUserMessage(original.lead.id, "First change");
          const saved = yield* waitFor((events) =>
            events.find((event) => event.agentId === original.lead.id && event.payload._tag === "FilesSaved"),
          );
          assert(saved.payload._tag === "FilesSaved" && saved.payload.turnId !== undefined);
          yield* orchestrator.sendUserMessage(original.lead.id, "Later change");
          yield* waitFor((events) =>
            events.filter(
              (event) => event.agentId === original.lead.id && event.payload._tag === "FilesSaved",
            ).length === 2
              ? true
              : undefined,
          );
          const point = { threadId: original.thread.id, turn: saved.payload.turnId };
          assert.deepStrictEqual(yield* orchestrator.previewForkThread(point), { snapshot: true });
          const fork = yield* orchestrator.forkThread({
            ...point,
            workspace: "worktree",
            harness: "codex",
            model: "destination-model",
          });
          assert(fork.thread.cwd !== undefined && fork.thread.cwd !== workspace);
          assert.strictEqual(fork.thread.cwd, path.join(fork.thread.worktree!.root, "app"));
          assert.deepStrictEqual(
            yield* orchestrator.previewForkThread({ threadId: fork.thread.id, turn: point.turn }),
            { snapshot: true },
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(fork.thread.cwd, "keep.txt")),
            "First change",
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(fork.thread.cwd, "new.txt")),
            "untracked in the selected turn",
          );
          assert.isFalse(yield* fs.exists(path.join(fork.thread.cwd, "remove.txt")));
          assert.strictEqual(yield* fs.readFileString(path.join(workspace, "keep.txt")), "Later change");
          assert.strictEqual(
            yield* fs.readFileString(path.join(workspace, "remove.txt")),
            "restored after the selected turn",
          );
          assert.isFalse(yield* fs.exists(path.join(workspace, "new.txt")));
          return fork;
        }).pipe(Effect.provide(layer()));

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator;
          const { waitFor } = yield* recordEvents;
          const overviews = yield* orchestrator.threadOverviews;
          assert.deepStrictEqual(
            overviews.find(({ thread }) => thread.id === fork.thread.id)?.thread.forkedFrom,
            fork.thread.forkedFrom,
          );
          yield* orchestrator.sendUserMessage(fork.lead.id, "Pick up here");
          yield* waitFor((events) =>
            events.find((event) => event.agentId === fork.lead.id && event.payload._tag === "TurnCompleted"),
          );
          const prompt = destination.sessions.at(-1)?.sent[0] ?? "";
          assert.include(prompt, "First change");
          assert.include(prompt, "Done: First change");
          assert.include(prompt, "Pick up here");
          assert.notInclude(prompt, "Later change");
          assert.strictEqual(destination.sessions.at(-1)?.options.model, "destination-model");
          assert.isUndefined(destination.sessions.at(-1)?.options.resume);
        }).pipe(Effect.provide(layer()));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
