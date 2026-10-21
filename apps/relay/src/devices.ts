import type {
  AccountProfile,
  Channel,
  ConnectionId,
  DeviceId,
  DeviceInfo,
  DeviceKind,
  NotificationKind,
  RelayMessage,
} from "@cerium/protocol";

// The account's devices as each of them sees them. Plain functions over the Account object's rows,
// so they're tested without the Workers runtime.

/** A row of the Account object's `devices` table. */
export type DeviceRow = {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly platform: string;
  readonly channel: Channel;
  readonly version: string;
  readonly rpc_version: number | null;
  readonly secret_hash: string;
  readonly created_at: number;
  readonly last_seen_at: number | null;
  /** The install it is (`Installation`); null for devices that joined before installs were told apart. */
  readonly installation: string | null;
};

export const toDeviceInfo = (
  row: DeviceRow,
  online: boolean,
  notifications?: ReadonlyArray<NotificationKind>,
): DeviceInfo => ({
  id: row.id as DeviceId,
  kind: row.kind,
  name: row.name,
  platform: row.platform,
  channel: row.channel,
  version: row.version,
  ...(row.rpc_version === null ? {} : { rpcVersion: row.rpc_version }),
  approved: true,
  online,
  createdAt: row.created_at,
  ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  ...(notifications === undefined ? {} : { notifications }),
});

/**
 * Devices an earlier sign-in of the same install left behind, from before installs were told apart:
 * of the devices alike in kind, system, channel and name, every one but the one seen last, unless it
 * is connected now.
 */
export const leftBehind = (
  rows: ReadonlyArray<DeviceRow>,
  online: ReadonlySet<string>,
): ReadonlyArray<DeviceRow> => {
  const seen = (row: DeviceRow) => Math.max(row.last_seen_at ?? 0, row.created_at);
  const alike = Map.groupBy(
    rows.filter((row) => row.installation === null),
    (row) => JSON.stringify([row.kind, row.platform, row.channel, row.name]),
  );
  return [...alike.values()].flatMap((group) =>
    group
      .toSorted((a, b) => seen(b) - seen(a))
      .slice(1)
      .filter((row) => !online.has(row.id)),
  );
};

/**
 * The state a device's socket is sent: every device of the account. `notifications` holds the kinds
 * each browser with push on gets.
 */
export const stateFor = (
  self: DeviceRow,
  rows: ReadonlyArray<DeviceRow>,
  online: ReadonlySet<string>,
  account: AccountProfile,
  connection?: string,
  notifications?: ReadonlyMap<string, ReadonlyArray<NotificationKind>>,
): Extract<RelayMessage, { readonly _tag: "State" }> => ({
  _tag: "State",
  account,
  self: self.id as DeviceId,
  ...(connection === undefined ? {} : { connection: connection as ConnectionId }),
  devices: rows.map((row) => toDeviceInfo(row, online.has(row.id), notifications?.get(row.id))),
});
