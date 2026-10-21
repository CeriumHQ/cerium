import type { TunnelAddress } from "@cerium/protocol";

import type { DeviceRow } from "./devices.ts";

// Where a tunnelled frame goes. The relay passes frames between an
// account's devices without reading them; these rules decide which connection gets one.

/** A connected socket, as the Account object knows it. */
export interface Live {
  readonly deviceId: string;
  readonly connection: string;
  readonly connectedAt: number;
}

export type Route = { readonly to: Live } | { readonly undeliverable: "offline" | "forbidden" };

const forbidden: Route = { undeliverable: "forbidden" };
const offline: Route = { undeliverable: "offline" };

/**
 * The connection a frame from `sender` to `address` goes to. Only the account's devices send or
 * receive, and only desktops are addressed by device, since only they run a backend to drive; a
 * desktop with more than one connection (an old one not yet closed) gets the frame on its newest.
 */
export const routeFrame = (
  sender: DeviceRow | undefined,
  address: TunnelAddress,
  rows: ReadonlyArray<DeviceRow>,
  live: ReadonlyArray<Live>,
): Route => {
  if (sender === undefined) return forbidden;
  if ("device" in address) {
    const target = rows.find((row) => row.id === address.device);
    if (target === undefined || target.kind !== "desktop") return forbidden;
    const newest = live
      .filter((each) => each.deviceId === target.id)
      .toSorted((a, b) => b.connectedAt - a.connectedAt)[0];
    return newest === undefined ? offline : { to: newest };
  }
  const to = live.find((each) => each.connection === address.connection);
  if (to === undefined) return offline;
  const target = rows.find((row) => row.id === to.deviceId);
  return target === undefined ? forbidden : { to };
};
