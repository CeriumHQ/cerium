import type { AccountId, AccountProfile } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { approvedOnLink, mayManage, stateFor, toDeviceInfo, type DeviceRow } from "../src/devices.ts";

const row = (id: string, approved: boolean, extra: Partial<DeviceRow> = {}): DeviceRow => ({
  id,
  kind: "desktop",
  name: `Machine ${id}`,
  platform: "win32",
  channel: "stable",
  version: "0.4.0",
  secret_hash: "0".repeat(64),
  created_at: 1_000,
  approved_at: approved ? 2_000 : null,
  last_seen_at: null,
  ...extra,
});

const account: AccountProfile = { id: "user_1" as AccountId, email: "me@example.com" };

describe("approval on link", () => {
  it("approves an account's first device", () => {
    expect(approvedOnLink([])).toBe(true);
  });

  it("waits for approval once another device is approved", () => {
    expect(approvedOnLink([row("a", true)])).toBe(false);
  });

  it("approves the next device of an account left with none approved", () => {
    expect(approvedOnLink([row("a", false), row("b", false)])).toBe(true);
  });
});

describe("managing devices", () => {
  const approved = row("a", true);
  const waiting = row("b", false);

  it("lets an approved device approve, rename and remove any device", () => {
    for (const action of ["approve", "rename", "remove"] as const) {
      expect(mayManage(approved, waiting, action)).toBe(true);
      expect(mayManage(approved, approved, action)).toBe(true);
    }
  });

  it("lets a waiting device only remove itself", () => {
    expect(mayManage(waiting, waiting, "remove")).toBe(true);
    expect(mayManage(waiting, waiting, "approve")).toBe(false);
    expect(mayManage(waiting, waiting, "rename")).toBe(false);
    expect(mayManage(waiting, approved, "remove")).toBe(false);
  });
});

describe("state sent to a device", () => {
  const rows = [row("a", true, { last_seen_at: 5_000 }), row("b", false)];

  it("lists every device, with who is online, once the device is approved", () => {
    const state = stateFor(rows[0]!, rows, new Set(["a"]), account);
    expect(state.self).toBe("a");
    expect(state.devices.map((device) => [device.id, device.online, device.approved])).toEqual([
      ["a", true, true],
      ["b", false, false],
    ]);
  });

  it("shows a waiting device only itself", () => {
    const state = stateFor(rows[1]!, rows, new Set(["a", "b"]), account);
    expect(state.devices.map((device) => device.id)).toEqual(["b"]);
  });

  it("leaves out when a device was last seen until it has connected", () => {
    expect(toDeviceInfo(rows[0]!, false).lastSeenAt).toBe(5_000);
    expect("lastSeenAt" in toDeviceInfo(rows[1]!, false)).toBe(false);
  });
});
