// @vitest-environment happy-dom

import { act, createElement as element } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CompactBar, connectionLine } from "../src/app/CompactBar.tsx";
import {
  beginClock,
  connectionStatusOf,
  connectionSubtitle,
  FLASH_MS,
  GRACE_MS,
  HOLD_MS,
  LIVE,
  observe,
  statusMark,
  useConnectionStatus,
  type ConnectionStatus,
  type ShownStatus,
  type StatusClock,
} from "../src/app/connectionStatus.ts";

const reconnecting: ConnectionStatus = { kind: "reconnecting" };
const offline: ConnectionStatus = {
  kind: "offline",
  machine: "studio-mac",
  presence: "Last seen 3 hours ago",
};

/** Drives a clock through `steps` of [time, raw status], returning what shows after each. */
const play = (start: ConnectionStatus, steps: ReadonlyArray<readonly [number, ConnectionStatus]>) => {
  let clock: StatusClock = beginClock(start, 0);
  return steps.map(([now, raw]) => {
    const next = observe(clock, raw, now);
    clock = next.clock;
    return { kind: clock.shown.kind, wake: next.wake };
  });
};

describe("connection status timing", () => {
  it("lets a line that's back within the grace go unsaid", () => {
    expect(
      play(LIVE, [
        [0, reconnecting],
        [GRACE_MS - 1, reconnecting],
        [GRACE_MS - 1, LIVE],
      ]),
    ).toEqual([
      { kind: "live", wake: GRACE_MS },
      { kind: "live", wake: GRACE_MS },
      { kind: "live", wake: undefined },
    ]);
  });

  it("says it's reconnecting once the grace runs out", () => {
    expect(
      play(LIVE, [
        [0, reconnecting],
        [GRACE_MS, reconnecting],
      ]).map((step) => step.kind),
    ).toEqual(["live", "reconnecting"]);
  });

  it("holds a degraded state, then flashes connected before going live", () => {
    const shown = GRACE_MS;
    const steps = play(LIVE, [
      [0, reconnecting],
      [shown, reconnecting],
      [shown + 10, LIVE],
      [shown + HOLD_MS, LIVE],
      [shown + HOLD_MS + FLASH_MS - 1, LIVE],
      [shown + HOLD_MS + FLASH_MS, LIVE],
    ]);
    expect(steps).toEqual([
      { kind: "live", wake: GRACE_MS },
      { kind: "reconnecting", wake: undefined },
      { kind: "reconnecting", wake: shown + HOLD_MS },
      { kind: "connected", wake: shown + HOLD_MS + FLASH_MS },
      { kind: "connected", wake: shown + HOLD_MS + FLASH_MS },
      { kind: "live", wake: undefined },
    ]);
  });

  it("shows an offline computer at once, and holds it before the next degraded state", () => {
    const steps = play(LIVE, [
      [0, offline],
      [100, reconnecting],
      [HOLD_MS, reconnecting],
    ]);
    expect(steps.map((step) => step.kind)).toEqual(["offline", "offline", "reconnecting"]);
  });

  it("updates a state's details in place without resetting its hold", () => {
    let clock = beginClock(offline, 0);
    clock = observe(clock, { ...offline, presence: "Last seen 4 hours ago" }, 300).clock;
    expect(clock.shown).toEqual({ ...offline, presence: "Last seen 4 hours ago" });
    expect(clock.shownAt).toBe(0);
    expect(observe(clock, LIVE, 400).wake).toBe(HOLD_MS);
  });

  it("ends the flash on time when the line drops again during it", () => {
    const back = HOLD_MS;
    const steps = play(offline, [
      [back, LIVE],
      [back + 100, reconnecting],
      [back + FLASH_MS, reconnecting],
      [back + 100 + GRACE_MS, reconnecting],
    ]);
    expect(steps.map((step) => step.kind)).toEqual(["connected", "connected", "live", "reconnecting"]);
  });

  it("returns the same clock when nothing changed", () => {
    const clock = beginClock(LIVE, 0);
    expect(observe(clock, { kind: "live" }, 50).clock).toBe(clock);
  });
});

describe("connection status copy", () => {
  it("words each state", () => {
    const words = (status: ShownStatus) => connectionSubtitle(status);
    expect(words(LIVE)).toBeUndefined();
    expect(words(reconnecting)).toBe("Reconnecting…");
    expect(words({ kind: "connected" })).toBe("Connected");
    expect(words(offline)).toBe("studio-mac · last seen 3 hours ago");
    expect(words({ kind: "offline", machine: "studio-mac" })).toBe("studio-mac · offline");
    expect(words({ kind: "cloud", machine: "studio-mac" })).toBe("Cloud copy · studio-mac");
    expect(words({ kind: "outdated", machine: "studio-mac" })).toBe("studio-mac · update needed");
  });

  it("marks degraded states, and none while live", () => {
    expect(statusMark(LIVE)).toBeUndefined();
    expect(statusMark(reconnecting)).toMatchObject({
      kind: "dot",
      className: expect.stringContaining("bg-attention"),
    });
    expect(statusMark(offline)).toMatchObject({
      kind: "dot",
      className: expect.stringContaining("ring-fg-disabled"),
    });
    expect(statusMark({ kind: "connected" })).toMatchObject({
      className: expect.stringContaining("bg-success"),
    });
    expect(statusMark({ kind: "cloud", machine: "a" })).toMatchObject({ kind: "icon" });
  });

  it("reads the raw status from the window's line and machines", () => {
    expect(connectionStatusOf({ connection: "connected" })).toEqual(LIVE);
    expect(connectionStatusOf({ connection: "reconnecting" })).toEqual(reconnecting);
    expect(connectionStatusOf({ connection: "unreachable" })).toEqual(reconnecting);
    expect(connectionStatusOf({ connection: "unreachable", web: true })).toEqual(LIVE);
    expect(
      connectionStatusOf({
        connection: "unreachable",
        driven: { name: "studio-mac" },
        presence: offline.presence,
      }),
    ).toEqual(offline);
    expect(
      connectionStatusOf({
        connection: "connected",
        cloud: { machine: "laptop", reach: { kind: "offline" } },
      }),
    ).toEqual({ kind: "cloud", machine: "laptop" });
    expect(
      connectionStatusOf({
        connection: "connected",
        cloud: { machine: "laptop", reach: { kind: "outdated" } },
      }),
    ).toEqual({ kind: "outdated", machine: "laptop" });
  });
});

describe("CompactBar", () => {
  it("makes the title block a labelled tap target", () => {
    const onTitleClick = vi.fn<() => void>();
    const html = renderToStaticMarkup(
      element(CompactBar, { title: "Fix auth", subtitle: "cerium", onTitleClick }),
    );
    expect(html).toContain('aria-label="Fix auth, thread details"');
    expect(html).toContain("min-h-10");
    expect(renderToStaticMarkup(element(CompactBar, { title: "", onTitleClick }))).toContain(
      'aria-label="Thread details"',
    );
    expect(renderToStaticMarkup(element(CompactBar, { title: "Fix auth" }))).not.toContain("thread details");
  });

  it("announces a keyed subtitle politely", () => {
    const line = connectionLine(reconnecting, "cerium");
    expect(line.subtitleKey).toBe("reconnecting");
    const html = renderToStaticMarkup(element(CompactBar, { title: "Fix auth", ...line }));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Reconnecting…");
    expect(connectionLine(LIVE, "cerium")).toEqual({ subtitle: "cerium", subtitleKey: "live" });
  });
});

describe("useConnectionStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  const shown: Array<string> = [];

  function Probe({ raw }: { raw: ConnectionStatus }) {
    shown.push(useConnectionStatus(raw).kind);
    return null;
  }

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    vi.useFakeTimers();
    shown.length = 0;
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const last = () => shown.at(-1);

  it("follows the timing rules on its own timers", () => {
    act(() => root.render(element(Probe, { raw: LIVE })));
    act(() => root.render(element(Probe, { raw: reconnecting })));
    expect(last()).toBe("live");
    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(last()).toBe("reconnecting");
    act(() => root.render(element(Probe, { raw: LIVE })));
    expect(last()).toBe("reconnecting");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(last()).toBe("connected");
    act(() => {
      vi.advanceTimersByTime(FLASH_MS);
    });
    expect(last()).toBe("live");
  });
});
