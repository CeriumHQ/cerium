import type {
  AccountProfile,
  Channel,
  DeviceId,
  DeviceInfo,
  DeviceKind,
  RelayMessage,
} from "@cerium/protocol";

// The account's devices and the rules for what each may do (docs/architecture.md §14.3). Plain
// functions over the Account object's rows, so they're tested without the Workers runtime.

/** A row of the Account object's `devices` table. */
export type DeviceRow = {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly platform: string;
  readonly channel: Channel;
  readonly version: string;
  readonly secret_hash: string;
  readonly created_at: number;
  readonly approved_at: number | null;
  readonly last_seen_at: number | null;
};

export const toDeviceInfo = (row: DeviceRow, online: boolean): DeviceInfo => ({
  id: row.id as DeviceId,
  kind: row.kind,
  name: row.name,
  platform: row.platform,
  channel: row.channel,
  version: row.version,
  approved: row.approved_at !== null,
  online,
  createdAt: row.created_at,
  ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
});

/** A newly linked device is approved at once only while the account has no approved device. */
export const approvedOnLink = (rows: ReadonlyArray<DeviceRow>): boolean =>
  !rows.some((row) => row.approved_at !== null);

export type DeviceAction = "approve" | "rename" | "remove";

/**
 * Whether `actor` may do `action` to `target`. Approved devices manage every device; one waiting
 * for approval may only remove itself, which is how it signs out.
 */
export const mayManage = (actor: DeviceRow, target: DeviceRow, action: DeviceAction): boolean =>
  actor.approved_at !== null || (action === "remove" && actor.id === target.id);

/** The state a device's socket is sent: every device once it's approved, only itself until then. */
export const stateFor = (
  self: DeviceRow,
  rows: ReadonlyArray<DeviceRow>,
  online: ReadonlySet<string>,
  account: AccountProfile,
): Extract<RelayMessage, { readonly _tag: "State" }> => ({
  _tag: "State",
  account,
  self: self.id as DeviceId,
  devices: (self.approved_at === null ? [self] : rows).map((row) => toDeviceInfo(row, online.has(row.id))),
});
