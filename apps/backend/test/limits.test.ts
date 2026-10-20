import type { ProviderUsage, ThreadNotification, UsageMeter, UsageSnapshot } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  assess,
  decodeAnnounced,
  limitNotification,
  limitWarnings,
  warningsOf,
  type Announcements,
} from "../src/limits.ts";
import { Notifications } from "../src/notify.ts";
import { SubscriptionUsage } from "../src/usage.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
const now = 1_000 * HOUR;

/** A meter halfway through a ten-hour window, so its pace is known. */
const paced = (usedPercent: number): UsageMeter => ({
  label: "Weekly",
  usedPercent,
  resetsAt: now + 5 * HOUR,
  windowMinutes: 600,
});
/** A meter that says when it resets but not how long its window is, so only its level counts. */
const unpaced = (usedPercent: number, resetsAt = now + 5 * HOUR): UsageMeter => ({
  label: "Weekly",
  usedPercent,
  resetsAt,
});
/** A meter that never resets. */
const bare = (usedPercent: number): UsageMeter => ({ label: "Weekly", usedPercent });

const claude = (meter: UsageMeter, extra: object = {}): ProviderUsage => ({
  _tag: "Subscribed",
  provider: "claude",
  meters: [meter],
  checkedAt: now,
  ...extra,
});

describe("what a meter warns about", () => {
  it("is nothing while it has plenty left and keeps pace", () => {
    expect(warningsOf(paced(30), now)).toEqual([]);
  });

  it("is amber and red as the harness grades them, or past 75% and 90%", () => {
    expect(warningsOf(unpaced(80), now)).toEqual(["warning"]);
    expect(warningsOf(unpaced(95), now)).toEqual(["critical", "warning"]);
    expect(warningsOf({ ...unpaced(20), level: "warning" }, now)).toEqual(["warning"]);
  });

  it("includes running out before the reset at the pace so far", () => {
    // 70% used with half the window gone: out in under 3 of the 5 hours left.
    expect(warningsOf(paced(70), now)).toEqual(["runsOut", "warning"]);
    // A meter that keeps pace does not run out first.
    expect(warningsOf(paced(52), now)).toEqual([]);
  });
});

describe("limit warnings", () => {
  it("tell a meter once when it turns amber, then again when it turns red, never twice for the same", () => {
    const first = assess([claude(unpaced(80))], new Map(), now);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toMatchObject({ kind: "limit", title: "Claude Code · Weekly" });
    expect(first.warnings[0]?.threadId).toBeUndefined();

    const again = assess([claude(unpaced(82))], first.announced, now + MINUTE);
    expect(again.warnings).toEqual([]);

    const red = assess([claude(unpaced(93))], again.announced, now + 2 * MINUTE);
    expect(red.warnings).toHaveLength(1);
    expect(red.warnings[0]?.detail).toContain("7% left");

    const stay = assess([claude(unpaced(96))], red.announced, now + 3 * MINUTE);
    expect(stay.warnings).toEqual([]);
  });

  it("say only the most pressing of what a meter crosses at once", () => {
    const { warnings } = assess([claude(unpaced(95))], new Map(), now);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).toMatch(/^5% left/);
  });

  it("say a meter will run out, and when, ahead of it turning amber", () => {
    const { warnings } = assess([claude(paced(65))], new Map(), now);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).toMatch(/^Runs out in ~.* at this rate · Resets in 5 hr$/);
  });

  it("start over when the window resets, and not when the reset time only wobbles", () => {
    const told = assess([claude(unpaced(80))], new Map(), now).announced;
    const wobble = unpaced(81, now + 5 * HOUR + 2 * MINUTE);
    expect(assess([claude(wobble)], told, now + MINUTE).warnings).toEqual([]);
    const nextWindow = unpaced(80, now + 5 * HOUR + WEEK);
    expect(assess([claude(nextWindow)], told, now + 6 * HOUR).warnings).toHaveLength(1);
  });

  it("start over for a meter with no reset time once its use falls a long way", () => {
    const told = assess([claude(bare(80))], new Map(), now).announced;
    expect(assess([claude(bare(78))], told, now + MINUTE).warnings).toEqual([]);
    const fallen = assess([claude(bare(10))], told, now + HOUR);
    expect(fallen.announced.size).toBe(0);
    expect(assess([claude(bare(80))], told, now + 2 * HOUR).warnings).toEqual([]);
    expect(assess([claude(bare(80))], fallen.announced, now + 2 * HOUR).warnings).toHaveLength(1);
  });

  it("keep what was told of a harness that can't be read now, and wait out stale readings", () => {
    const told = assess([claude(unpaced(80))], new Map(), now).announced;
    const unreadable: ProviderUsage = { _tag: "UsageUnreadable", provider: "claude", message: "No answer" };
    expect(assess([unreadable], told, now + MINUTE)).toEqual({ warnings: [], announced: told });
    const stale = claude(unpaced(97), { refreshError: "Offline" });
    expect(assess([stale], told, now + MINUTE)).toEqual({ warnings: [], announced: told });
  });

  it("word a meter that ran out", () => {
    expect(limitNotification("codex", paced(100), "critical", now)).toEqual({
      kind: "limit",
      title: "Codex · Weekly",
      detail: "Limit reached · Resets in 5 hr",
    });
  });
});

describe("what is remembered of the warnings", () => {
  it("reads back what was written, and nothing from what isn't theirs", () => {
    const told: Announcements = new Map([
      ["claude\u0000Weekly", { usedPercent: 80, thresholds: ["warning"] }],
    ]);
    expect(decodeAnnounced(Object.fromEntries(told))).toEqual(told);
    expect(decodeAnnounced({ x: "nope" })).toEqual(new Map());
    expect(decodeAnnounced(undefined)).toEqual(new Map());
  });
});

describe("the limit warnings of a running backend", () => {
  /** A backend whose usage the test feeds, with what it told and what it remembered. */
  const backend = (remembered?: unknown) =>
    Effect.gen(function* () {
      const snapshots = yield* Queue.unbounded<UsageSnapshot>();
      const told: Array<ThreadNotification> = [];
      const saved: Array<Readonly<Record<string, unknown>>> = [];
      const store = Layer.succeed(Store, {
        readSettings: Effect.succeed(remembered === undefined ? {} : { usageWarned: remembered }),
        writeSettings: (values: Readonly<Record<string, unknown>>) =>
          Effect.sync(() => void saved.push(values)),
      } as never);
      const usage = Layer.succeed(SubscriptionUsage, { watch: Stream.fromQueue(snapshots) });
      const notifications = Layer.succeed(Notifications, {
        told: Stream.empty,
        tell: (notification: ThreadNotification) => Effect.sync(() => void told.push(notification)),
      });
      yield* Layer.build(limitWarnings.pipe(Layer.provide(Layer.mergeAll(store, usage, notifications))));
      const read = (meter: UsageMeter) =>
        Queue.offer(snapshots, { usage: [claude(meter)], checking: false }).pipe(
          Effect.andThen(Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))),
        );
      return { told, saved, read };
    });

  it.effect("tell a meter that turned red once, however often it is read, and remember it", () =>
    Effect.gen(function* () {
      const { told, saved, read } = yield* backend();
      yield* read(bare(50));
      yield* read(unpaced(95, 5 * HOUR));
      yield* read(unpaced(96, 5 * HOUR));
      assert.strictEqual(told.length, 1);
      assert.strictEqual(told[0]?.kind, "limit");
      assert.strictEqual(told[0]?.title, "Claude Code · Weekly");
      assert.strictEqual(saved.length, 1);
      assert.isDefined(saved[0]?.["usageWarned"]);
    }).pipe(Effect.scoped),
  );

  it.effect("stay quiet about a meter told of before the backend restarted", () =>
    Effect.gen(function* () {
      const first = yield* backend();
      yield* first.read(unpaced(95, 5 * HOUR));
      const remembered = first.saved[0]?.["usageWarned"];
      const { told, read } = yield* backend(remembered);
      yield* read(unpaced(95, 5 * HOUR));
      assert.strictEqual(first.told.length, 1);
      assert.deepStrictEqual(told, []);
    }).pipe(Effect.scoped),
  );
});
