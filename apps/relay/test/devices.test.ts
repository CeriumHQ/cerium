import type { AccountId, AccountProfile } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { leftBehind, stateFor, type DeviceRow } from "../src/devices.ts";

const row = (id: string, extra: Partial<DeviceRow> = {}): DeviceRow => ({
  id,
  kind: "desktop",
  name: `Machine ${id}`,
  platform: "win32",
  channel: "stable",
  version: "0.4.0",
  rpcVersion: 1,
  secretHash: "0".repeat(64),
  createdAt: 1_000,
  lastSeenAt: null,
  installation: null,
  ...extra,
});

const account: AccountProfile = { id: "user_1" as AccountId, email: "me@example.com" };

describe("state sent to a device", () => {
  const rows = [row("a", { lastSeenAt: 5_000 }), row("b")];

  it("lists every device, with who is online", () => {
    const state = stateFor(rows[1]!, rows, new Set(["a"]), account);
    expect(state.self).toBe("b");
    expect(state.devices.map((device) => [device.id, device.online])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

describe("devices earlier sign-ins left behind", () => {
  const phone = (id: string, created: number, seen: number | null, extra: Partial<DeviceRow> = {}) =>
    row(id, {
      kind: "browser",
      name: "iPhone",
      platform: "ios",
      rpcVersion: null,
      createdAt: created,
      lastSeenAt: seen,
      ...extra,
    });

  it("keeps the copy seen last and finds the others", () => {
    const rows = [phone("old", 1, 10), phone("older", 0, 5), phone("now", 20, 30), phone("never", 15, null)];
    expect(leftBehind(rows, new Set()).map((each) => each.id)).toEqual(["never", "old", "older"]);
  });

  it("keeps devices that differ in kind, system, channel or name", () => {
    const rows = [
      phone("a", 1, 10),
      phone("b", 1, 10, { name: "iPad" }),
      phone("c", 1, 10, { platform: "android" }),
      phone("d", 1, 10, { channel: "nightly" }),
      phone("e", 1, 10, { kind: "desktop" }),
    ];
    expect(leftBehind(rows, new Set())).toEqual([]);
  });

  it("keeps a copy that's connected now", () => {
    const rows = [phone("new", 20, 30), phone("old", 1, 10)];
    expect(leftBehind(rows, new Set(["old"]))).toEqual([]);
  });

  it("leaves alone devices that know their install", () => {
    const rows = [phone("new", 20, 30), phone("old", 1, 10, { installation: "install_0123456789ab" })];
    expect(leftBehind(rows, new Set())).toEqual([]);
  });
});
