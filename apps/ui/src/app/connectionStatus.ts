import { Cloud, MonitorUp, type LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

// What the compact window says about its line to the backend, in the CompactBar's subtitle and as a
// mark on the buttons that lead to it. The line itself flaps: a dropped socket that's back in a
// second isn't worth a word, and a state that shows at all stays long enough to be read.

/** How the line to the thread's computer stands, as the window's data has it right now. */
export type ConnectionStatus =
  | { readonly kind: "live" }
  | { readonly kind: "reconnecting" }
  /** The computer the window drives isn't answering; `presence` says since when, when the relay knows. */
  | { readonly kind: "offline"; readonly machine: string; readonly presence?: string | undefined }
  /** The thread is the account's copy of one on another computer. */
  | { readonly kind: "cloud"; readonly machine: string }
  /** That computer's backend is too old to drive. */
  | { readonly kind: "outdated"; readonly machine: string };

/** What the window shows: the status, or for a moment after a degraded one, that it's back. */
export type ShownStatus = ConnectionStatus | { readonly kind: "connected" };

/** How long the line may be away before the window says it's reconnecting. */
export const GRACE_MS = 2_000;
/** The least time a degraded state stays on screen once shown. */
export const HOLD_MS = 600;
/** How long "Connected" shows on the way back to live. */
export const FLASH_MS = 1_200;

export const LIVE: ConnectionStatus = { kind: "live" };
const CONNECTED: ShownStatus = { kind: "connected" };

export interface StatusClock {
  readonly shown: ShownStatus;
  /** When `shown` took its kind. */
  readonly shownAt: number;
  readonly raw: ConnectionStatus;
  /** When `raw` took its kind. */
  readonly rawAt: number;
}

export const isDegraded = (status: ShownStatus) => status.kind !== "live" && status.kind !== "connected";

const sameStatus = (a: ShownStatus, b: ShownStatus) => statusKey(a) === statusKey(b);

/** A string that changes whenever what's shown for a status would. */
export const statusKey = (status: ShownStatus) =>
  status.kind === "offline"
    ? `offline:${status.machine}:${status.presence ?? ""}`
    : status.kind === "cloud" || status.kind === "outdated"
      ? `${status.kind}:${status.machine}`
      : status.kind;

/** The clock for a window that opens on `raw`: a line still coming up shows nothing yet. */
export const beginClock = (raw: ConnectionStatus, now: number): StatusClock =>
  settle({ shown: LIVE, shownAt: now, raw, rawAt: now }, now).clock;

/**
 * Moves the clock to `now` with the latest `raw` status. Returns the same clock when nothing changed,
 * and when the shown status next changes on its own, the time to look again.
 */
export function observe(
  clock: StatusClock,
  raw: ConnectionStatus,
  now: number,
): { readonly clock: StatusClock; readonly wake: number | undefined } {
  const next = sameStatus(clock.raw, raw)
    ? clock
    : { ...clock, raw, rawAt: raw.kind === clock.raw.kind ? clock.rawAt : now };
  return settle(next, now);
}

function settle(clock: StatusClock, now: number) {
  for (;;) {
    const { shown, shownAt, raw, rawAt } = clock;
    let next: ShownStatus;
    let at: number;
    if (raw.kind === "live") {
      if (shown.kind === "live") return { clock, wake: undefined };
      // Back from a degraded state: it says so for a moment, once the degraded one has had its time.
      [next, at] = shown.kind === "connected" ? [LIVE, shownAt + FLASH_MS] : [CONNECTED, shownAt + HOLD_MS];
    } else if (isDegraded(shown)) {
      if (sameStatus(shown, raw)) return { clock, wake: undefined };
      // The same state with new details, such as a later "last seen", updates in place.
      [next, at] = [raw, shown.kind === raw.kind ? now : shownAt + HOLD_MS];
    } else if (
      shown.kind === "connected" &&
      raw.kind === "reconnecting" &&
      rawAt + GRACE_MS > shownAt + FLASH_MS
    ) {
      // A line lost again during the flash: the flash ends on time, and the grace runs on.
      [next, at] = [LIVE, shownAt + FLASH_MS];
    } else {
      [next, at] = [raw, raw.kind === "reconnecting" ? rawAt + GRACE_MS : now];
    }
    if (at > now) return { clock, wake: at };
    clock = { ...clock, shown: next, shownAt: next.kind === shown.kind ? shownAt : at };
  }
}

/** The status to show for `raw`, following the timing rules above as it changes. */
export function useConnectionStatus(raw: ConnectionStatus): ShownStatus {
  const [timeline] = useState(() => new StatusTimeline(raw));
  useEffect(() => timeline.update(raw), [timeline, raw]);
  return useSyncExternalStore(timeline.subscribe, timeline.shown);
}

/** A clock on its own timers, which the hook reads as an external store. */
class StatusTimeline {
  #clock: StatusClock;
  #wake: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(raw: ConnectionStatus) {
    this.#clock = beginClock(raw, Date.now());
  }

  readonly shown = () => this.#clock.shown;

  update(raw: ConnectionStatus) {
    this.#apply(observe(this.#clock, raw, Date.now()));
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#wake = undefined;
      this.update(this.#clock.raw);
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return;
      clearTimeout(this.#timer);
      this.#wake = undefined;
    };
  };

  #apply({ clock, wake }: { readonly clock: StatusClock; readonly wake: number | undefined }) {
    const changed = clock !== this.#clock;
    this.#clock = clock;
    if (wake !== this.#wake) {
      clearTimeout(this.#timer);
      this.#wake = wake;
      if (wake !== undefined)
        this.#timer = setTimeout(
          () => {
            this.#wake = undefined;
            this.update(this.#clock.raw);
          },
          Math.max(0, wake - Date.now()),
        );
    }
    if (changed) for (const listener of this.#listeners) listener();
  }
}

/**
 * The raw status from what the window knows: the line to its backend, the computer it drives, and
 * for a thread read from the cloud copy, that thread's computer and how it can be reached.
 */
export function connectionStatusOf({
  connection,
  driven,
  presence,
  cloud,
  web = false,
}: {
  readonly connection: "connecting" | "reconnecting" | "connected" | "unreachable";
  readonly driven?: { readonly name: string } | undefined;
  /** The driven computer's presence, such as "Last seen 3 hours ago", while it's away. */
  readonly presence?: string | undefined;
  readonly cloud?: { readonly machine: string; readonly reach: { readonly kind: string } } | undefined;
  /** The web client, whose own backend is the relay: only the driven computer can be away. */
  readonly web?: boolean;
}): ConnectionStatus {
  if (cloud?.reach.kind === "outdated") return { kind: "outdated", machine: cloud.machine };
  if (cloud !== undefined) return { kind: "cloud", machine: cloud.machine };
  if (connection === "unreachable" && driven !== undefined)
    return { kind: "offline", machine: driven.name, presence };
  return connection === "reconnecting" || (connection === "unreachable" && !web)
    ? { kind: "reconnecting" }
    : LIVE;
}

/** The CompactBar's subtitle for a status, or undefined where the pane's own context line shows. */
export function connectionSubtitle(status: ShownStatus): string | undefined {
  switch (status.kind) {
    case "live":
      return undefined;
    case "reconnecting":
      return "Reconnecting…";
    case "connected":
      return "Connected";
    case "offline":
      return status.presence
        ? `${status.machine} · ${status.presence.toLowerCase()}`
        : `${status.machine} · offline`;
    case "cloud":
      return `Cloud copy · ${status.machine}`;
    case "outdated":
      return `${status.machine} · update needed`;
  }
}

/** The small mark beside a status: a dot, a hollow ring, or an icon. */
export type StatusMark =
  | { readonly kind: "dot"; readonly className: string }
  | { readonly kind: "icon"; readonly icon: LucideIcon; readonly className: string };

/** The 6px dot's own look, without its placement. */
const dot = "size-1.5 rounded-full";

/** The mark a status carries, or undefined while live. */
export function statusMark(status: ShownStatus): StatusMark | undefined {
  switch (status.kind) {
    case "live":
      return undefined;
    case "reconnecting":
      return {
        kind: "dot",
        className: `${dot} bg-attention animate-[pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none`,
      };
    case "connected":
      return {
        kind: "dot",
        className: `${dot} bg-success transition-[scale] duration-200 ease-pop starting:scale-60 motion-reduce:transition-none`,
      };
    case "offline":
      return { kind: "dot", className: `${dot} ring-1 ring-fg-disabled` };
    case "cloud":
      return { kind: "icon", icon: Cloud, className: "text-fg-tertiary" };
    case "outdated":
      return { kind: "icon", icon: MonitorUp, className: "text-fg-tertiary" };
  }
}
