import type { AccountId, AccountState, DeviceId, DeviceInfo } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  deviceDetails,
  initials,
  orderedDevices,
  presenceLabel,
  reachOf,
  waitingDevices,
  whyUnreachable,
} from "../src/features/account/model.ts";

const device = (id: string, extra: Partial<DeviceInfo> = {}): DeviceInfo => ({
  id: id as DeviceId,
  kind: "desktop",
  name: `Machine ${id}`,
  platform: "win32",
  channel: "stable",
  version: "0.4.0",
  approved: true,
  online: false,
  createdAt: 0,
  ...extra,
});

const signedIn = (self: string, devices: ReadonlyArray<DeviceInfo>): AccountState => ({
  _tag: "SignedIn",
  account: { id: "user_1" as AccountId },
  deviceId: self as DeviceId,
  connection: "online",
  devices,
});

describe("device details", () => {
  it("name the platform, a channel other than stable, and the version", () => {
    expect(deviceDetails(device("a"))).toBe("Windows · 0.4.0");
    expect(deviceDetails(device("a", { channel: "nightly", version: "0.5.0-nightly.12" }))).toBe(
      "Windows · Nightly · 0.5.0-nightly.12",
    );
    expect(deviceDetails(device("a", { channel: "dev", version: "dev", platform: "darwin" }))).toBe(
      "macOS · Development build",
    );
  });
});

describe("waiting devices", () => {
  it("are the other devices not yet approved, shown to an approved one", () => {
    const state = signedIn("a", [device("a"), device("b", { approved: false }), device("c")]);
    expect(waitingDevices(state).map((each) => each.id)).toEqual(["b"]);
  });

  it("are hidden from a device that is itself waiting", () => {
    expect(waitingDevices(signedIn("b", [device("b", { approved: false })]))).toEqual([]);
  });

  it("don't exist while signed out", () => {
    expect(waitingDevices({ _tag: "SignedOut" })).toEqual([]);
  });

  it("wait for the connection, since allowing one takes the relay", () => {
    const state = signedIn("a", [device("a"), device("b", { approved: false })]);
    if (state._tag !== "SignedIn") throw new Error("signed in");
    expect(waitingDevices({ ...state, connection: "offline" })).toEqual([]);
  });
});

describe("device order", () => {
  it("puts this machine first, then the rest in the order they joined, waiting or not", () => {
    const state = signedIn("m", [
      device("z", { name: "Zeta", createdAt: 3 }),
      device("w", { name: "Waiting", approved: false, createdAt: 4 }),
      device("m", { name: "Mine", createdAt: 2 }),
      device("a", { name: "Alpha", createdAt: 1 }),
    ]);
    if (state._tag !== "SignedIn") throw new Error("signed in");
    expect(orderedDevices(state).map((each) => each.name)).toEqual(["Mine", "Alpha", "Zeta", "Waiting"]);
  });
});

describe("presence", () => {
  const now = Date.UTC(2026, 9, 18, 12);
  it("says online, or when the device was last seen", () => {
    expect(presenceLabel(device("a", { online: true }), now)).toBe("Online");
    expect(presenceLabel(device("a"), now)).toBe("Never connected");
    expect(presenceLabel(device("a", { lastSeenAt: now - 20_000 }), now)).toBe("Last seen just now");
    expect(presenceLabel(device("a", { lastSeenAt: now - 5 * 60_000 }), now)).toBe("Last seen 5 minutes ago");
  });
});

describe("reaching another desktop", () => {
  it("works while it's online with a backend this UI can drive", () => {
    expect(whyUnreachable(device("b", { online: true, rpcVersion: 1 }))).toBeUndefined();
  });

  it("says when it's offline, or too old to drive", () => {
    expect(whyUnreachable(device("b", { rpcVersion: 1 }))).toBe("Never connected");
    expect(whyUnreachable(device("b", { online: true }))).toBe("Update Cerium there to reach it");
  });

  it("tells an old backend from a missing one, whatever its connection", () => {
    expect(reachOf(device("b", { online: true }))).toEqual({ kind: "outdated" });
    expect(reachOf(device("b", { rpcVersion: 1 }))).toEqual({ kind: "offline", presence: "Never connected" });
    expect(reachOf(device("b", { online: true, rpcVersion: 1 }))).toEqual({ kind: "reachable" });
  });
});

describe("initials", () => {
  it("come from the name, else the email", () => {
    expect(initials("Ada Lovelace King", undefined)).toBe("AL");
    expect(initials(undefined, "nonlooped@example.com")).toBe("N");
    expect(initials("  ", undefined)).toBe("?");
  });
});
