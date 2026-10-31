import { describe, expect, it } from "@effect/vitest";

import type { DeviceRow } from "../src/devices.ts";
import { isShowing, kindsOf, PRESENCE_FRESH_MS, recipients, threadKey, type PushRow } from "../src/notify.ts";

const device = (id: string, kind: DeviceRow["kind"]): DeviceRow => ({
  id,
  kind,
  name: id,
  platform: kind === "browser" ? "ios" : "win32",
  channel: "stable",
  version: "1.0.0",
  rpcVersion: kind === "desktop" ? 1 : null,
  secretHash: "0".repeat(64),
  createdAt: 1,
  lastSeenAt: null,
  installation: null,
});

const subscription = (device: string, kinds: ReadonlyArray<string>): PushRow => ({
  device,
  endpoint: `https://web.push.apple.com/${device}`,
  p256dh: "key",
  auth: "auth",
  kinds: JSON.stringify(kinds),
  updatedAt: 1,
});

// "gone" subscribed, then left the account.
const devices = [device("pc", "desktop"), device("phone", "browser"), device("tablet", "browser")];
const everything = ["needsYou", "finished", "failed", "limit"];
const thread = threadKey("pc", "thread_1");

describe("who a notification goes to", () => {
  it("goes to every browser of the account that wants its kind", () => {
    const rows = [
      subscription("phone", everything),
      subscription("tablet", ["needsYou"]),
      subscription("gone", everything),
    ];
    expect(recipients("needsYou", thread, rows, devices, []).map((row) => row.device)).toEqual([
      "phone",
      "tablet",
    ]);
    expect(recipients("finished", thread, rows, devices, []).map((row) => row.device)).toEqual(["phone"]);
  });

  it("goes nowhere while a window anywhere shows the thread", () => {
    const rows = [subscription("phone", everything)];
    const showing = [{ deviceId: "pc", visible: true, viewing: thread }];
    expect(recipients("finished", thread, rows, devices, showing)).toEqual([]);
    const elsewhere = [{ deviceId: "pc", visible: true, viewing: threadKey("pc", "thread_2") }];
    expect(recipients("finished", thread, rows, devices, elsewhere)).toHaveLength(1);
  });

  it("sends a usage limit, which has no thread, to browsers that want it and aren't showing Cerium", () => {
    const rows = [
      subscription("phone", everything),
      subscription("tablet", ["needsYou", "finished", "failed"]),
    ];
    // A window open on some thread doesn't hush it: the limit isn't about that thread.
    const showing = [{ deviceId: "pc", visible: true, viewing: thread }];
    expect(recipients("limit", undefined, rows, devices, showing).map((row) => row.device)).toEqual([
      "phone",
    ]);
    expect(recipients("limit", undefined, rows, devices, [{ deviceId: "phone", visible: true }])).toEqual([]);
  });

  it("skips a browser that shows Cerium now: it sees what happened itself", () => {
    const rows = [subscription("phone", everything), subscription("tablet", everything)];
    const showing = [{ deviceId: "phone", visible: true }];
    expect(recipients("failed", thread, rows, devices, showing).map((row) => row.device)).toEqual(["tablet"]);
  });

  it("counts a window as showing only while it's heard from", () => {
    const now = 1_000_000;
    expect(isShowing({ visible: true, presenceAt: now - 1000 }, 0, now)).toBe(true);
    expect(isShowing({ visible: false, presenceAt: now }, now, now)).toBe(false);
    // A phone that put Cerium in the background without saying so goes quiet: it stops pinging.
    expect(isShowing({ visible: true, presenceAt: now - PRESENCE_FRESH_MS }, 0, now)).toBe(false);
    expect(isShowing({ visible: true, presenceAt: now - PRESENCE_FRESH_MS }, now - 5000, now)).toBe(true);
  });

  it("reads only the kinds it knows from a stored row", () => {
    expect(kindsOf(subscription("phone", ["finished", "other"]))).toEqual(["finished"]);
    expect(kindsOf({ ...subscription("phone", []), kinds: "not json" })).toEqual([]);
  });
});
