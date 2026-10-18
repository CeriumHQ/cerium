import { describe, expect, it } from "@effect/vitest";

import type { DeviceRow } from "../src/devices.ts";
import {
  isShowing,
  kindsOf,
  notificationBody,
  PRESENCE_FRESH_MS,
  recipients,
  threadKey,
  type PushRow,
} from "../src/notify.ts";

const device = (id: string, kind: DeviceRow["kind"], approved = true): DeviceRow => ({
  id,
  kind,
  name: id,
  platform: kind === "browser" ? "ios" : "win32",
  channel: "stable",
  version: "1.0.0",
  rpc_version: kind === "desktop" ? 1 : null,
  secret_hash: "0".repeat(64),
  created_at: 1,
  approved_at: approved ? 1 : null,
  last_seen_at: null,
});

const subscription = (device: string, kinds: ReadonlyArray<string>): PushRow => ({
  device,
  endpoint: `https://web.push.apple.com/${device}`,
  p256dh: "key",
  auth: "auth",
  kinds: JSON.stringify(kinds),
  updated_at: 1,
});

const devices = [
  device("pc", "desktop"),
  device("phone", "browser"),
  device("tablet", "browser"),
  device("new", "browser", false),
];
const everything = ["needsYou", "finished", "failed"];
const thread = threadKey("pc", "thread_1");

describe("who a notification goes to", () => {
  it("goes to every approved browser that wants its kind", () => {
    const rows = [
      subscription("phone", everything),
      subscription("tablet", ["needsYou"]),
      subscription("new", everything),
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

describe("a notification's text", () => {
  it("says what happened, then the detail on a line of its own", () => {
    expect(notificationBody("finished", "I fixed the redirect and the tests pass.")).toBe(
      "Finished\nI fixed the redirect and the tests pass.",
    );
    expect(notificationBody("needsYou", "Claude: Run npm test")).toBe(
      "Waiting for your approval\nClaude: Run npm test",
    );
    expect(notificationBody("failed")).toBe("Failed");
    expect(notificationBody("failed", "  ")).toBe("Failed");
  });

  it("names the computer when the account has more than one", () => {
    expect(notificationBody("finished", undefined, "Office PC")).toBe("Finished on Office PC");
  });
});
