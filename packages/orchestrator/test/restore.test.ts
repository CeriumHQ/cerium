import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload } from "@cerium/protocol";
import { assert, describe, expect, it } from "@effect/vitest";
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
  const layer = Layer.succeed(Checkpoints, {
    save: () =>
      Effect.sync(() => {
        const id = `s${snapshots.size}`;
        snapshots.set(id, new Map(files));
        return id;
      }),
    changes: (_folder, from, to) =>
      Effect.sync(() => {
        const before = snapshots.get(from) ?? new Map<string, string>();
        const after = snapshots.get(to) ?? new Map<string, string>();
        const changes: Array<SnapshotChange> = [];
        for (const path of new Set([...before.keys(), ...after.keys()])) {
          const [was, is] = [before.get(path), after.get(path)];
          if (was === is) continue;
          changes.push({
            path,
            change: was === undefined ? "added" : is === undefined ? "deleted" : "modified",
          });
        }
        return changes;
      }),
    restore: (_folder, snapshot, paths) =>
      Effect.sync(() => {
        restores.push({ snapshot, paths });
        const held = snapshots.get(snapshot) ?? new Map<string, string>();
        for (const path of paths) {
          const content = held.get(path);
          if (content === undefined) files.delete(path);
          else files.set(path, content);
        }
      }),
  });
  return { files, restores, layer };
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
        expect(preview).toMatchObject({
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
