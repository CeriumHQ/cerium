import {
  compareHistory,
  HISTORY_STATE_TAGS,
  type AgentEvent,
  type AgentId,
  type EventId,
  type EventPayload,
  type HistoryCursor,
  type HistoryPage,
  type ThreadId,
} from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { fillGap, jumpThrough, type Gap } from "../src/backend/deepJump.ts";
import { ThreadLog } from "../src/backend/threadLog.ts";
import { buildTranscript } from "../src/features/transcript/model.ts";

const PAGE = 4;
const event = (n: number, payload: EventPayload): AgentEvent => ({
  id: `e${String(n).padStart(4, "0")}` as EventId,
  threadId: "t" as ThreadId,
  agentId: "a" as AgentId,
  sequence: n,
  at: n,
  payload,
});
const cursorOf = ({ at, sequence, id }: AgentEvent): HistoryCursor => ({ at, sequence, id });

/** Turn k: its input, two tool calls, its answer. Five events per turn, tools in the middle. */
const turn = (k: number): ReadonlyArray<AgentEvent> => {
  const n = k * 5;
  return [
    event(n, {
      _tag: "TurnInput",
      items: [{ _tag: "FromUser", id: `u${k}`, text: `question ${k}` }],
    }),
    event(n + 1, { _tag: "ToolCallStarted", callId: `c${k}`, toolName: "read", input: {} }),
    event(n + 2, {
      _tag: "ToolCallCompleted",
      callId: `c${k}`,
      output: "x".repeat(10),
    } as EventPayload),
    event(n + 3, { _tag: "MessageCompleted", messageId: `m${k}`, text: `answer ${k}` }),
    event(n + 4, { _tag: "TurnCompleted", stopReason: "completed" }),
  ];
};
const thread = (turns: number, extra: ReadonlyArray<AgentEvent> = []) =>
  [...Array.from({ length: turns }, (_, k) => turn(k)).flat(), ...extra].toSorted(compareHistory);

/** A paged store that answers the way the backend's `ThreadHistory` does, and counts what it served. */
const store = (all: ReadonlyArray<AgentEvent>) => {
  const served = { state: 0, full: 0, fullEvents: 0, stateEvents: 0 };
  const stateTags = new Set<string>(HISTORY_STATE_TAGS);
  const read = (request: { readonly before: HistoryCursor; readonly state?: boolean }) =>
    Effect.sync((): HistoryPage => {
      const older = all.filter(
        (each) =>
          compareHistory(each, request.before) < 0 &&
          (request.state !== true || stateTags.has(each.payload._tag)),
      );
      const selected = older.slice(-PAGE);
      if (request.state === true) {
        served.state++;
        served.stateEvents += selected.length;
      } else {
        served.full++;
        served.fullEvents += selected.length;
      }
      return {
        events: selected,
        ...(selected[0] === undefined ? {} : { before: cursorOf(selected[0]) }),
        after: all.length,
        more: older.length > PAGE,
      };
    });
  return { read, served };
};

/** The newest suffix a thread opens with: its last two turns, the way `ThreadHistory` pages from the end. */
const opened = (all: ReadonlyArray<AgentEvent>, count = 10) => {
  const log = new ThreadLog();
  const suffix = all.slice(-count);
  log.add(suffix);
  return { log, newest: cursorOf(suffix[0]!) };
};

const messageIds = (log: ThreadLog) =>
  buildTranscript(log.snapshot())
    .filter((block) => block.kind === "message" || block.kind === "user")
    .map((block) => block.id);

describe("deep jump", () => {
  it.effect("reads the gap as state only and the target's own page in full", () =>
    Effect.gen(function* () {
      const all = thread(40);
      const { read, served } = store(all);
      const { log, newest } = opened(all);
      const target = cursorOf(all.find((each) => each.id === "e0103")!);
      const jump = yield* jumpThrough(read, log, target, newest);
      assert.strictEqual(log.hasEvent(target.id), true);
      // The target's turn keeps its tool calls: they sit in the full page read just before its successor.
      assert.strictEqual(
        log.snapshot().some((each) => each.id === "e0102"),
        true,
      );
      // Between the target and the newest suffix only state events were read: tool calls stay unread.
      assert.strictEqual(served.full, 1);
      assert.strictEqual(served.fullEvents, PAGE);
      assert.strictEqual(
        log.snapshot().some((each) => each.id === "e0151"),
        false,
      );
      assert.deepStrictEqual(jump.gap.newer, newest);
      assert.isAbove(compareHistory(jump.gap.older, target), 0);
      assert.isDefined(jump.before);
      assert.strictEqual(jump.more, true);
    }),
  );

  it.effect("reaches an old message in far fewer reads than paging every event", () =>
    Effect.gen(function* () {
      const all = thread(200);
      const { read, served } = store(all);
      const { log, newest } = opened(all);
      const target = cursorOf(all.find((each) => each.id === "e0008")!);
      yield* jumpThrough(read, log, target, newest);
      const everyPage = Math.ceil((all.length - 10) / PAGE);
      assert.strictEqual(served.full, 1);
      assert.isBelow(served.stateEvents, all.length * 0.7);
      assert.isBelow(served.state + served.full, everyPage * 0.7);
    }),
  );

  it.effect("keeps a rewind inside the gap, so the jump shows what the thread really says", () =>
    Effect.gen(function* () {
      const base = thread(30);
      const rewind: AgentEvent = {
        ...event(75, { _tag: "ConversationRewound", fromSequence: 70, messageId: "m14", via: "replay" }),
        id: "e0075x" as EventId,
        at: 75.5,
        sequence: 76,
      };
      const all = [...base, rewind].toSorted(compareHistory);
      const { read } = store(all);
      const { log, newest } = opened(all);
      const target = cursorOf(all.find((each) => each.id === "e0043")!);
      yield* jumpThrough(read, log, target, newest);
      assert.strictEqual(log.hasEvent("e0075x"), true);
    }),
  );

  it.effect("takes the newest loaded event as the successor when the target is the last state event", () =>
    Effect.gen(function* () {
      const all = thread(6);
      const { read } = store(all);
      const { log, newest } = opened(all, 7);
      const target = cursorOf(all.find((each) => each.id === "e0018")!);
      const jump = yield* jumpThrough(read, log, target, newest);
      assert.strictEqual(log.hasEvent(target.id), true);
      assert.isAtMost(compareHistory(jump.gap.older, jump.gap.newer), 0);
    }),
  );

  it.effect("fails and leaves the log alone when the target is not in the thread", () =>
    Effect.gen(function* () {
      const all = thread(10);
      const { read } = store(all);
      const { log, newest } = opened(all);
      const before = log.snapshot().length;
      const missing: HistoryCursor = { at: 3.5, sequence: 3, id: "e0003x" as EventId };
      const outcome = yield* Effect.exit(jumpThrough(read, log, missing, newest));
      assert.strictEqual(outcome._tag, "Failure");
      assert.strictEqual(log.snapshot().length, before);
    }),
  );

  it.effect("adds nothing when a read fails part way", () =>
    Effect.gen(function* () {
      const all = thread(30);
      const { read } = store(all);
      let calls = 0;
      const flaky: typeof read = (request) =>
        ++calls === 3 ? Effect.fail("offline" as never) : read(request);
      const { log, newest } = opened(all);
      const before = log.snapshot().length;
      const target = cursorOf(all.find((each) => each.id === "e0003")!);
      const outcome = yield* Effect.exit(jumpThrough(flaky, log, target, newest));
      assert.strictEqual(outcome._tag, "Failure");
      assert.strictEqual(log.snapshot().length, before);
    }),
  );

  it.effect("loads the gap's tool calls on request, and only the gap's", () =>
    Effect.gen(function* () {
      const all = thread(40);
      const { read } = store(all);
      const { log, newest } = opened(all);
      const target = cursorOf(all.find((each) => each.id === "e0103")!);
      const { gap, before } = yield* jumpThrough(read, log, target, newest);
      assert.strictEqual(log.hasEvent("e0151"), false);
      yield* fillGap(read, log, gap);
      for (const id of ["e0151", "e0152", "e0126", "e0176"]) assert.isTrue(log.hasEvent(id));
      // Nothing older than the target's window was read for it.
      const oldest = log.snapshot()[0]!;
      assert.isAtLeast(compareHistory(oldest, before!), 0);
      assert.include(messageIds(log), "message:m20");
    }),
  );

  it.effect("fills a gap that ends at the newest loaded event", () =>
    Effect.gen(function* () {
      const all = thread(6);
      const { read } = store(all);
      const { log } = opened(all, 7);
      const gap: Gap = {
        newer: cursorOf(all[all.length - 7]!),
        older: cursorOf(all[all.length - 7]!),
      };
      yield* fillGap(read, log, gap);
      assert.strictEqual(log.snapshot().length, 7);
    }),
  );
});
