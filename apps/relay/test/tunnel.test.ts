import type { ConnectionId, DeviceId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import type { DeviceRow } from "../src/devices.ts";
import { routeFrame, type Live } from "../src/tunnel.ts";

const row = (id: string, extra: Partial<DeviceRow> = {}): DeviceRow => ({
  id,
  kind: "desktop",
  name: id,
  platform: "win32",
  channel: "stable",
  version: "0.4.0",
  rpc_version: 1,
  secret_hash: "0".repeat(64),
  created_at: 0,
  approved_at: 1,
  last_seen_at: null,
  ...extra,
});

const rows = [
  row("laptop"),
  row("desk"),
  row("phone", { kind: "browser" }),
  row("stranger", { approved_at: null }),
];
const live: ReadonlyArray<Live> = [
  { deviceId: "laptop", connection: "conn-laptop", connectedAt: 1 },
  { deviceId: "desk", connection: "conn-desk-old", connectedAt: 1 },
  { deviceId: "desk", connection: "conn-desk-new", connectedAt: 2 },
  { deviceId: "phone", connection: "conn-phone", connectedAt: 1 },
  { deviceId: "stranger", connection: "conn-stranger", connectedAt: 1 },
];
const device = (id: string) => ({ device: id as DeviceId });
const connection = (id: string) => ({ connection: id as ConnectionId });
const sender = (id: string) => rows.find((each) => each.id === id);

describe("routing a frame", () => {
  it("reaches a desktop on its newest connection", () => {
    expect(routeFrame(sender("laptop"), device("desk"), rows, live)).toEqual({
      to: { deviceId: "desk", connection: "conn-desk-new", connectedAt: 2 },
    });
  });

  it("answers the connection that wrote first, browsers included", () => {
    expect(routeFrame(sender("desk"), connection("conn-phone"), rows, live)).toEqual({
      to: { deviceId: "phone", connection: "conn-phone", connectedAt: 1 },
    });
  });

  it("says a desktop that isn't connected is offline", () => {
    expect(routeFrame(sender("laptop"), device("desk"), rows, live.slice(0, 1))).toEqual({
      undeliverable: "offline",
    });
    expect(routeFrame(sender("desk"), connection("conn-gone"), rows, live)).toEqual({
      undeliverable: "offline",
    });
  });

  it("refuses senders and targets that aren't approved, unknown devices and browsers as hosts", () => {
    expect(routeFrame(sender("stranger"), device("desk"), rows, live)).toEqual({
      undeliverable: "forbidden",
    });
    expect(routeFrame(sender("laptop"), device("stranger"), rows, live)).toEqual({
      undeliverable: "forbidden",
    });
    expect(routeFrame(sender("laptop"), connection("conn-stranger"), rows, live)).toEqual({
      undeliverable: "forbidden",
    });
    expect(routeFrame(sender("laptop"), device("phone"), rows, live)).toEqual({ undeliverable: "forbidden" });
    expect(routeFrame(undefined, device("desk"), rows, live)).toEqual({ undeliverable: "forbidden" });
  });
});
