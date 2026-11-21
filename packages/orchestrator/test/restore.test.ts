import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { Checkpoints, Orchestrator, type SnapshotChange } from "../src/index.ts";
import { planRestore, workSince } from "../src/restore.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const event = (sequence: number, at: number, payload: EventPayload): AgentEvent =>
  ({ id: `a:${sequence}`, threadId: "t", agentId: "a", sequence, at, payload }) as AgentEvent;

describe("restore plans", () => {
  it("counts an agent's turns from a point on, closing each at the snapshot taken after it", () => {
    const events = [
      event(0, 1, { _tag: "TurnInput", items: [{ _tag: "SystemNotice", text: "x" }], files: "s0" }),
      event(1, 2, { _tag: "FileChanged", path: "before.ts", change: "modified" }),
      event(2, 3, { _tag: "FilesSaved", snapshot: "s1" }),
      event(3, 10, { _tag: "TurnInput", items: [{ _tag: "SystemNotice", text: "y" }], files: "s1" }),
      event(4, 11, { _tag: "FileChanged", path: "after.ts", change: "created" }),
      event(5, 12, { _tag: "FilesSaved", snapshot: "s2" }),
      // Still running: it counts up to now.
      event(6, 13, { _tag: "TurnInput", items: [{ _tag: "SystemNotice", text: "z" }], files: "s2" }),
    ];
    assert.deepStrictEqual(workSince(events, 10), {
      spans: [{ from: "s1", to: "s2" }, { from: "s2" }],
      files: ["after.ts"],
    });
  });

  it("pairs a snapshot saved behind its turn with that turn, though the next has begun", () => {
    const turn = (sequence: number, turnId: string, files: string) =>
      event(sequence, sequence, {
        _tag: "TurnInput",
        items: [{ _tag: "SystemNotice", text: turnId }],
        turnId,
        files,
      });
    const events = [
      turn(0, "t1", "s0"),
      turn(1, "t2", "s1"),
      event(2, 2, { _tag: "FilesSaved", snapshot: "s1", turnId: "t1" }),
      event(3, 3, { _tag: "FilesSaved", snapshot: "s2", turnId: "t2" }),
    ];
    assert.deepStrictEqual(workSince(events, 0).spans, [
      { from: "s0", to: "s1" },
      { from: "s1", to: "s2" },
    ]);
  });

  it("puts back what only this thread changed, and keeps what another thread changed too", () => {
    const differing: ReadonlyArray<SnapshotChange> = [
      { path: "src/z.ts", change: "added" },
      { path: "src/a.ts", change: "modified" },
      { path: "gone.ts", change: "deleted" },
      { path: "shared.ts", change: "modified" },
      { path: "user.ts", change: "modified" },
    ];
    const plan = planRestore(
      differing,
      new Set(["src/a.ts", "src/z.ts", "gone.ts", "shared.ts", "unchanged.ts"]),
      new Map([["shared.ts", "Other thread"]]),
    );
    assert.deepStrictEqual(plan, {
      restored: [
        { path: "gone.ts", undo: "delete" },
        { path: "src/a.ts", undo: "edit" },
        { path: "src/z.ts", undo: "create" },
      ],
      kept: [{ path: "shared.ts", thread: "Other thread" }],
    });
  });
});

/** A folder held in memory, and snapshots of it that work like the real ones. */
const fakeFolder = () => {
  const files = new Map<string, string>();
  const snapshots = new Map<string, ReadonlyMap<string, string>>();
  const restores: Array<{ readonly snapshot: string; readonly paths: ReadonlyArray<string> }> = [];
  const compared: Array<ReadonlyArray<string> | undefined> = [];
  const layer = Layer.succeed(Checkpoints, {
    save: () =>
      Effect.sync(() => {
        const id = `s${snapshots.size}`;
        snapshots.set(id, new Map(files));
        return id;
      }),
    changes: (_folder, from, to, paths) =>
      Effect.sync(() => {
        compared.push(paths);
        const before = snapshots.get(from) ?? new Map<string, string>();
        const after = snapshots.get(to) ?? new Map<string, string>();
        const changes: Array<SnapshotChange> = [];
        for (const path of new Set(paths ?? [...before.keys(), ...after.keys()])) {
          const [was, is] = [before.get(path), after.get(path)];
          if (was === is) continue;
          changes.push({
            path,
            change: was === undefined ? "added" : is === undefined ? "deleted" : "modified",
          });
        }
        return changes;
      }),
    // Each file counts as one line.
    lines: (_folder, from, to) =>
      Effect.sync(() => {
        const before = snapshots.get(from) ?? new Map<string, string>();
        const after = snapshots.get(to) ?? new Map<string, string>();
        return [...new Set([...before.keys(), ...after.keys()])]
          .filter((path) => before.get(path) !== after.get(path))
          .map((path) => ({
            path,
            added: after.has(path) ? 1 : 0,
            removed: before.has(path) ? 1 : 0,
          }));
      }),
    diff: () => Effect.succeed(""),
    restoreInto: () => Effect.void,
    restore: (_folder, snapshot, paths) =>
      Effect.sync(() => {
        restores.push({ snapshot, paths });
        const held = snapshots.get(snapshot) ?? new Map<string, string>();
        for (const path of paths) {
          const content = held.get(path);
          if (content === undefined) files.delete(path);
          else files.set(path, content);
        }
        return [];
      }),
  });
  return { files, restores, compared, layer };
};

describe("Orchestrator restore", () => {
  it.live(
    "puts back the files the thread changed since a message, leaving another thread's and the user's",
    () => {
      const folder = fakeFolder();
      // Each turn's reply is where the agent changes files.
      const fake = makeFakeAdapter("claude", {
        reply: (text) => {
          if (text === "one") folder.files.set("a.ts", "1");
          if (text === "two") {
            folder.files.set("a.ts", "2");
            folder.files.set("b.ts", "new");
          }
          if (text === "three") folder.files.set("shared.ts", "from this thread");
          if (text === "elsewhere") folder.files.set("shared.ts", "from the other thread");
          return `reply to: ${text}`;
        },
      });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { seen, waitFor } = yield* recordEvents;
        const turnsEnded = (agentId: AgentId, count: number) =>
          waitFor((events) =>
            events.filter((e) => e.agentId === agentId && e.payload._tag === "FilesSaved").length >= count
              ? true
              : undefined,
          );
        folder.files.set("shared.ts", "at first");
        const start = (title: string) =>
          orchestrator.createThread({
            title,
            mode: "work",
            cwd: ".",
            lead: { provider: "claude", model: "opus", access: "acceptEdits" },
          });
        const { lead } = yield* start("This thread");
        const { lead: other } = yield* start("Other thread");
        for (const [index, text] of ["one", "two", "three"].entries()) {
          yield* orchestrator.sendUserMessage(lead.id, text);
          yield* turnsEnded(lead.id, index + 1);
        }
        yield* orchestrator.sendUserMessage(other.id, "elsewhere");
        yield* turnsEnded(other.id, 1);
        // The user's own edit between turns is no agent's.
        folder.files.set("notes.md", "mine");

        const two = seen.flatMap((e) =>
          e.agentId === lead.id && e.payload._tag === "MessageQueued" && e.payload.message.text === "two"
            ? [e.payload.message.id ?? ""]
            : [],
        )[0];
        assert.isDefined(two);
        const preview = yield* orchestrator.previewRestore(lead.id, two ?? "");
        assert.deepStrictEqual(preview, {
          messageId: two,
          messages: 2,
          conversation: "replay",
          agents: [],
          files: {
            restored: [
              { path: "a.ts", undo: "edit" },
              { path: "b.ts", undo: "create" },
            ],
            kept: [{ path: "shared.ts", thread: "Other thread" }],
          },
        });

        const message = yield* orchestrator.restoreBefore(lead.id, two ?? "");
        assert.strictEqual(message.text, "two");
        assert.deepStrictEqual(Object.fromEntries(folder.files), {
          "a.ts": "1",
          "shared.ts": "from the other thread",
          "notes.md": "mine",
        });
        const events = yield* orchestrator.threadEvents(lead.threadId);
        const tags = events.filter((e) => e.agentId === lead.id).map((e) => e.payload._tag);
        assert.includeMembers(tags, ["ConversationRewound", "FilesRestored"]);
        const restored = events.find((e) => e.payload._tag === "FilesRestored")?.payload;
        assert.deepStrictEqual(restored, { _tag: "FilesRestored", messageId: two, paths: ["a.ts", "b.ts"] });
      }).pipe(Effect.provide(testLayer([fake.adapter], { checkpoints: folder.layer })), Effect.scoped);
    },
  );

  it.live("lists the files each turn changed, by edit tool or command, and undoes and redoes them", () => {
    const folder = fakeFolder();
    const fake = makeFakeAdapter("claude", {
      work: (text) => {
        if (text === "edit") {
          folder.files.set("a.ts", "edited");
          return [{ _tag: "FileChanged", path: "a.ts", change: "created" }];
        }
        if (text === "run") {
          folder.files.set("gen.ts", "generated");
          folder.files.set("a.ts", "rewritten");
          return [
            { _tag: "ToolCallStarted", callId: "c1", toolName: "Bash", input: { command: "node gen.js" } },
          ];
        }
        // The user's edit while the agent only talks is no turn's.
        folder.files.set("notes.md", "mine");
        return [];
      },
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Work",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "acceptEdits" },
      });
      const saved = (count: number) =>
        waitFor((events) =>
          events.filter((e) => e.payload._tag === "FilesSaved").length >= count ? true : undefined,
        );
      const changed = () =>
        orchestrator
          .threadEvents(lead.threadId)
          .pipe(
            Effect.map((events) =>
              events.flatMap((e) => (e.payload._tag === "TurnFilesChanged" ? [e.payload] : [])),
            ),
          );
      for (const [index, text] of ["edit", "run", "talk"].entries()) {
        yield* orchestrator.sendUserMessage(lead.id, text);
        yield* saved(index + 1);
        // The summary is recorded just behind the snapshot.
        yield* Effect.sleep("20 millis");
      }
      const [edit, run, ...rest] = yield* changed();
      assert.deepStrictEqual(rest, []);
      assert.deepStrictEqual(edit?.files, [
        { path: "a.ts", change: "added", added: 1, removed: 0, via: "edit" },
      ]);
      assert.deepStrictEqual(run?.files, [
        { path: "a.ts", change: "modified", added: 1, removed: 1, via: "command" },
        { path: "gen.ts", change: "added", added: 1, removed: 0, via: "command" },
      ]);

      // Undoing the command's turn puts both back, except a file changed since.
      folder.files.set("gen.ts", "changed by hand");
      const undone = yield* orchestrator.revertTurn(lead.id, run?.turnId ?? "", "undone");
      assert.deepStrictEqual(undone, {
        _tag: "TurnFilesReverted",
        turnId: run?.turnId ?? "",
        direction: "undone",
        paths: ["a.ts"],
        kept: ["gen.ts"],
      });
      assert.strictEqual(folder.files.get("a.ts"), "edited");
      assert.strictEqual(folder.files.get("gen.ts"), "changed by hand");
      const again = yield* Effect.flip(orchestrator.revertTurn(lead.id, run?.turnId ?? "", "undone"));
      assert.match(again.message, /already undone/);

      const redone = yield* orchestrator.revertTurn(lead.id, run?.turnId ?? "", "redone");
      assert.deepStrictEqual(redone.paths, ["a.ts"]);
      assert.strictEqual(folder.files.get("a.ts"), "rewritten");
    }).pipe(Effect.provide(testLayer([fake.adapter], { checkpoints: folder.layer })), Effect.scoped);
  });

  it.live("only compares and restores the eligible paths of a per-file or whole-turn request", () => {
    const folder = fakeFolder();
    const paths = ["a.ts", "b.ts", "c.ts"];
    folder.files.set("a.ts", "before a");
    folder.files.set("b.ts", "before b");
    const fake = makeFakeAdapter("claude", {
      complete: () => "Work",
      work: () =>
        paths.map((path) => {
          const change = folder.files.has(path) ? "modified" : "created";
          folder.files.set(path, `after ${path}`);
          return { _tag: "FileChanged", path, change };
        }),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Work",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", access: "acceptEdits" },
      });
      yield* orchestrator.sendUserMessage(lead.id, "edit");
      const turnId = yield* waitFor(
        (events) =>
          events.flatMap(({ agentId, payload }) =>
            agentId === lead.id && payload._tag === "TurnFilesChanged" ? [payload.turnId] : [],
          )[0],
      );
      const revert = (direction: "undone" | "redone", requested?: ReadonlyArray<string>) =>
        orchestrator.revertTurn(lead.id, turnId, direction, requested);

      for (const invalid of [[], ["a.ts", "other.ts"]]) {
        const error = yield* Effect.flip(revert("undone", invalid));
        assert.strictEqual(error.reason, "invalid");
      }
      assert.isEmpty(folder.restores);

      const undoB = yield* revert("undone", ["b.ts", "b.ts"]);
      assert.deepStrictEqual(undoB, {
        _tag: "TurnFilesReverted",
        turnId,
        direction: "undone",
        paths: ["b.ts"],
        kept: [],
        partial: true,
      });
      assert.deepStrictEqual(folder.compared.at(-1), ["b.ts"]);
      assert.deepStrictEqual(Object.fromEntries(folder.files), {
        "a.ts": "after a.ts",
        "b.ts": "before b",
        "c.ts": "after c.ts",
      });
      const error = yield* Effect.flip(revert("undone", ["b.ts"]));
      assert.strictEqual(error.reason, "invalid");

      folder.files.set("b.ts", "edited after undo");
      const keptB = yield* revert("redone", ["b.ts"]);
      assert.deepStrictEqual(keptB.paths, []);
      assert.deepStrictEqual(keptB.kept, ["b.ts"]);
      assert.strictEqual(folder.files.get("b.ts"), "edited after undo");
      folder.files.set("b.ts", "before b");
      const redoB = yield* revert("redone", ["b.ts"]);
      assert.deepStrictEqual(redoB.paths, ["b.ts"]);
      assert.strictEqual(folder.files.get("b.ts"), "after b.ts");

      folder.files.set("a.ts", "edited after the turn");
      const undoSubset = yield* revert("undone", ["a.ts", "b.ts"]);
      assert.deepStrictEqual(undoSubset.paths, ["b.ts"]);
      assert.deepStrictEqual(undoSubset.kept, ["a.ts"]);
      assert.deepStrictEqual(folder.compared.at(-1), ["a.ts", "b.ts"]);
      assert.strictEqual(folder.files.get("c.ts"), "after c.ts");
      assert.strictEqual(folder.files.get("a.ts"), "edited after the turn");

      folder.files.set("a.ts", "after a.ts");
      const undoRest = yield* revert("undone");
      assert.deepStrictEqual(undoRest.paths, ["a.ts", "c.ts"]);
      assert.deepStrictEqual(folder.compared.at(-1), ["a.ts", "c.ts"]);
      assert.notProperty(undoRest, "partial");
      assert.deepStrictEqual(Object.fromEntries(folder.files), { "a.ts": "before a", "b.ts": "before b" });

      const redoA = yield* revert("redone", ["a.ts"]);
      assert.deepStrictEqual(redoA.paths, ["a.ts"]);
      assert.deepStrictEqual(Object.fromEntries(folder.files), { "a.ts": "after a.ts", "b.ts": "before b" });
      const redoRest = yield* revert("redone");
      assert.deepStrictEqual(redoRest.paths, ["b.ts", "c.ts"]);
      assert.deepStrictEqual(Object.fromEntries(folder.files), {
        "a.ts": "after a.ts",
        "b.ts": "after b.ts",
        "c.ts": "after c.ts",
      });

      const events = yield* orchestrator.threadEvents(lead.threadId);
      assert.deepStrictEqual(
        events.flatMap(({ payload }) => (payload._tag === "TurnFilesReverted" ? [payload] : [])),
        [undoB, keptB, redoB, undoSubset, undoRest, redoA, redoRest],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { checkpoints: folder.layer })), Effect.scoped);
  });

  it.live("goes back in a chat without touching files, and says so in the preview", () => {
    const folder = fakeFolder();
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Chat",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor((events) => events.find((e) => e.payload._tag === "TurnCompleted"));
      const hello = seen.flatMap((e) =>
        e.payload._tag === "MessageQueued" ? [e.payload.message.id ?? ""] : [],
      )[0];
      const preview = yield* orchestrator.previewRestore(lead.id, hello ?? "");
      assert.strictEqual(preview.conversation, "fresh");
      assert.isUndefined(preview.files);
      yield* orchestrator.restoreBefore(lead.id, hello ?? "");
      assert.deepStrictEqual(folder.restores, []);
    }).pipe(Effect.provide(testLayer([fake.adapter], { checkpoints: folder.layer })), Effect.scoped);
  });
});
