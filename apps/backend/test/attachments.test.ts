import type {
  AgentEvent,
  AgentId,
  AgentInfo,
  Attachment,
  EventId,
  ThreadId,
  ThreadInfo,
} from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";

import { sweepAttachments, uuidv7Time } from "../src/attachments.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12);

const thread: ThreadInfo = {
  id: "thr_1" as ThreadId,
  title: "Paste",
  mode: "chat",
  createdAt: 1,
  updatedAt: 1,
};

const lead: AgentInfo = {
  id: "agt_lead" as AgentId,
  threadId: thread.id,
  role: "lead",
  provider: "claude",
  model: "opus",
  access: "ask",
  state: "idle",
  createdAt: 1,
  updatedAt: 1,
};

/** The user's message carrying `attachments`, as the orchestrator stores it. */
const sent = (sequence: number, attachments: ReadonlyArray<Attachment>): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: thread.id,
  agentId: lead.id,
  sequence,
  at: sequence,
  payload: { _tag: "TurnInput", items: [{ _tag: "FromUser", text: "Look at these", attachments }] },
});

/** The user's message carrying `attachments`, accepted but still waiting for its turn. */
const queued = (sequence: number, attachments: ReadonlyArray<Attachment>): AgentEvent => ({
  ...sent(sequence, attachments),
  payload: { _tag: "MessageQueued", message: { _tag: "FromUser", text: "And this", attachments } },
});

const TestLayer = Layer.mergeAll(Store.layer({ filename: ":memory:" }), NodeServices.layer);

describe("uuidv7Time", () => {
  it.effect("reads when a UUIDv7 was made, and nothing from other names", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      yield* TestClock.setTime(NOW);
      assert.strictEqual(uuidv7Time(yield* crypto.randomUUIDv7()), NOW);
      assert.isUndefined(uuidv7Time(yield* crypto.randomUUIDv4()));
      assert.isUndefined(uuidv7Time("notes"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("sweepAttachments", () => {
  it.effect("removes old pasted files no sent message names, and keeps everything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const store = yield* Store;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(root, "attachments");

      /** Saves a file the way `Workspace.saveAttachment` does, `hoursAgo` before now. */
      const paste = Effect.fn(function* (name: string, hoursAgo: number) {
        yield* TestClock.setTime(NOW - hoursAgo * HOUR);
        const folder = path.join(directory, yield* crypto.randomUUIDv7());
        yield* fs.makeDirectory(folder, { recursive: true });
        const file = path.join(folder, name);
        yield* fs.writeFileString(file, name);
        return { path: file, name, mediaType: "image/png" } satisfies Attachment;
      });
      const sentLongAgo = yield* paste("sent.png", 40 * 24);
      const stillQueued = yield* paste("queued.png", 35 * 24);
      const removedFromDraft = yield* paste("removed.png", 32 * 24);
      // Drafts outlast restarts, so a file can wait in one for days.
      const inDraft = yield* paste("draft.png", 7 * 24);

      // Not Cerium's to remove: a folder it didn't name, and the user's own file sent by its path.
      const stranger = path.join(directory, "notes");
      yield* fs.makeDirectory(stranger);
      const own = path.join(root, "own.png");
      yield* fs.writeFileString(own, "own");

      yield* store.createThread(thread);
      yield* store.createAgent(lead);
      yield* store.appendEvents([
        sent(0, [sentLongAgo, { path: own, name: "own.png", mediaType: "image/png" }]),
        queued(1, [stillQueued]),
      ]);

      yield* TestClock.setTime(NOW);
      yield* sweepAttachments(directory);

      assert.isTrue(yield* fs.exists(sentLongAgo.path));
      assert.isTrue(yield* fs.exists(stillQueued.path));
      assert.isFalse(yield* fs.exists(path.dirname(removedFromDraft.path)));
      assert.isTrue(yield* fs.exists(inDraft.path));
      assert.isTrue(yield* fs.exists(stranger));
      assert.isTrue(yield* fs.exists(own));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("does nothing before anything was pasted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* sweepAttachments(path.join(root, "attachments"));
      assert.deepStrictEqual(yield* fs.readDirectory(root), []);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
