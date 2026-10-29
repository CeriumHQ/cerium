import {
  EpochMillis,
  leftLabel,
  MAX_NOTIFICATION_DETAIL,
  MAX_THREAD_TITLE,
  meterLevel,
  paceOf,
  resetLabel,
  runsOutLabel,
  type ProviderUsage,
  type ThreadNotification,
  type UsageMeter,
} from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Clock, Effect, Layer, Option, Ref, Schema, Stream } from "effect";

import { harnessName } from "./discord.ts";
import { Notifications } from "./notify.ts";
import { SubscriptionUsage } from "./usage.ts";

// Limit warnings. A harness's usage meters are read in the background (usage.ts), and this machine
// says when one turns amber or red, or would run out before it resets at the rate it is used: to its
// own window and the account's browsers, by the push path threads' notifications take. Each warning is
// told once per reset window, and remembered across restarts so a still-red meter isn't told again.

/** What a meter can warn about, most pressing first. */
const THRESHOLDS = ["critical", "runsOut", "warning"] as const;
export type Threshold = (typeof THRESHOLDS)[number];

/** What was told of one meter in its current window. */
const Announced = Schema.Struct({
  resetsAt: Schema.optionalKey(EpochMillis),
  usedPercent: Schema.Finite,
  thresholds: Schema.Array(Schema.Literals(THRESHOLDS)),
});
export type Announced = typeof Announced.Type;

/** Every meter with something told, as `meterKey` names it. */
export type Announcements = ReadonlyMap<string, Announced>;

const Stored = Schema.Record(Schema.String, Announced);

/** Where the store keeps what was told: beside the settings, though no setting reads it. */
const STORE_KEY = "usageWarned";

/** A reset time that moves less than this between reads is the same window; harnesses round theirs. */
const RESET_SLACK = 10 * 60_000;

/** For a meter that never says when it resets: a fall in use this large is a window starting again. */
const DROP_AS_RESET = 20;

const meterKey = (provider: string, meter: UsageMeter) => `${provider}\u0000${meter.label}`;

const sameWindow = (before: Announced, meter: UsageMeter): boolean =>
  before.resetsAt !== undefined && meter.resetsAt !== undefined
    ? Math.abs(meter.resetsAt - before.resetsAt) <= RESET_SLACK
    : before.resetsAt === undefined &&
      meter.resetsAt === undefined &&
      meter.usedPercent > before.usedPercent - DROP_AS_RESET;

/** What the meter warns about now: amber, red, and running out before it resets at its pace so far. */
export const warningsOf = (meter: UsageMeter, now: number): ReadonlyArray<Threshold> => {
  const pace = paceOf(meter, now);
  const level = meterLevel(meter, pace);
  return THRESHOLDS.filter((threshold) => {
    switch (threshold) {
      case "critical":
        return level === "critical";
      case "runsOut":
        return pace?.fast === true && pace.runsOutAt !== undefined;
      case "warning":
        return level !== "normal";
    }
  });
};

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

/** The notification for a meter that crossed `threshold`: its title names it, its detail says where it stands. */
export const limitNotification = (
  provider: ProviderUsage["provider"],
  meter: UsageMeter,
  threshold: Threshold,
  now: number,
): ThreadNotification => {
  const pace = paceOf(meter, now);
  const standing =
    threshold === "runsOut" && pace?.runsOutAt !== undefined
      ? `${runsOutLabel(pace.runsOutAt, now)} at this rate`
      : leftLabel(meter);
  const detail = [
    standing,
    meter.resetsAt === undefined ? undefined : resetLabel(meter.resetsAt, now, meter.resetDayOnly),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  return {
    kind: "limit",
    title: clip(`${harnessName[provider]} · ${meter.label}`, MAX_THREAD_TITLE),
    detail: clip(detail, MAX_NOTIFICATION_DETAIL),
  };
};

/**
 * The warnings a reading of the harnesses' usage brings, given what was told already, and what is
 * told after them. A meter that crosses several thresholds at once warns once, about the most pressing;
 * each threshold is told once per window of the meter, so a meter that stays red says nothing more.
 * Meters of a harness that couldn't be read now keep what was told of them.
 */
export const assess = (
  usage: ReadonlyArray<ProviderUsage>,
  announced: Announcements,
  now: number,
): { readonly warnings: ReadonlyArray<ThreadNotification>; readonly announced: Announcements } => {
  const warnings: Array<ThreadNotification> = [];
  const read = new Set<string>();
  const next = new Map<string, Announced>();
  for (const each of usage) {
    if (each._tag !== "Subscribed" || each.refreshError !== undefined) continue;
    read.add(each.provider);
    for (const meter of each.meters) {
      const key = meterKey(each.provider, meter);
      const before = announced.get(key);
      const told = before !== undefined && sameWindow(before, meter) ? before.thresholds : [];
      const reached = warningsOf(meter, now);
      const fresh = THRESHOLDS.find((threshold) => reached.includes(threshold) && !told.includes(threshold));
      if (fresh !== undefined) warnings.push(limitNotification(each.provider, meter, fresh, now));
      const thresholds = THRESHOLDS.filter(
        (threshold) => reached.includes(threshold) || told.includes(threshold),
      );
      if (thresholds.length > 0) {
        next.set(key, {
          ...(meter.resetsAt === undefined ? {} : { resetsAt: meter.resetsAt }),
          usedPercent: meter.usedPercent,
          thresholds,
        });
      }
    }
  }
  for (const [key, each] of announced) {
    if (!read.has(key.slice(0, key.indexOf("\u0000")))) next.set(key, each);
  }
  return { warnings, announced: next };
};

/** What of the announcements is worth keeping: which thresholds were told in which window. */
const remembered = (announced: Announcements): string =>
  JSON.stringify([...announced].map(([key, { resetsAt, thresholds }]) => [key, resetsAt, thresholds]));

/** What the store remembers of what was told; nothing when it holds nothing usable. */
export const decodeAnnounced = (stored: unknown): Announcements =>
  new Map(Object.entries(Option.getOrElse(Schema.decodeUnknownOption(Stored)(stored), () => ({}))));

/**
 * Tells the user when a subscription's meter turns amber or red, or would run out before it resets
 * (see the notes above). Watching the usage keeps the harnesses read in the background, so the
 * warnings come without Settings → Limits open. Requires `Store`, `SubscriptionUsage` and `Notifications`.
 */
export const limitWarnings = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const usage = yield* SubscriptionUsage;
    const notifications = yield* Notifications;
    const told = yield* Ref.make<Announcements>(
      decodeAnnounced(
        yield* store.readSettings.pipe(
          Effect.map((settings) => settings[STORE_KEY]),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    );
    yield* usage.watch.pipe(
      Stream.runForEach((snapshot) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const before = yield* Ref.get(told);
          const { warnings, announced } = assess(snapshot.usage, before, now);
          yield* Ref.set(told, announced);
          yield* Effect.forEach(warnings, notifications.tell, { discard: true });
          // Remembered when something was told or a window moved, not each time a meter creeps up.
          if (remembered(announced) !== remembered(before)) {
            yield* store.writeSettings({ [STORE_KEY]: Object.fromEntries(announced) }).pipe(Effect.ignore);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
