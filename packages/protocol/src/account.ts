import { Schema } from "effect";

import { DeviceId, EpochMillis } from "./ids.ts";
import { SyncMessage, SyncNotice } from "./sync.ts";

// Cerium accounts (docs/architecture.md §14): what a signed-in machine and Cerium's relay say to each
// other, and what the UI shows about the account's devices.

/** A Cerium account: the Clerk user it belongs to, by that user's id. */
export const AccountId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(
  Schema.brand("cerium/AccountId"),
);
export type AccountId = typeof AccountId.Type;

/** A pending sign-in. Unguessable: whoever holds it can see which machine is signing in. */
export const LinkId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,}$/)).pipe(
  Schema.brand("cerium/LinkId"),
);
export type LinkId = typeof LinkId.Type;

/** A desktop runs Cerium and its agents; a browser (the phone's web app) drives desktops. */
export const DeviceKind = Schema.Literals(["desktop", "browser"]);
export type DeviceKind = typeof DeviceKind.Type;

/** The build a desktop runs: nightlies keep their own data, so they are machines of their own. */
export const Channel = Schema.Literals(["stable", "nightly", "dev"]);
export type Channel = typeof Channel.Type;

export const MAX_DEVICE_NAME = 64;

/** What a device is called in lists: trimmed, 1 to 64 characters. */
export const DeviceName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_DEVICE_NAME));

/** What a device says about itself when it signs in. */
export const DeviceDraft = Schema.Struct({
  kind: DeviceKind,
  name: DeviceName,
  /** Node's `process.platform` for a desktop (`win32`, `darwin`, `linux`). */
  platform: Schema.NonEmptyString,
  channel: Channel,
  version: Schema.NonEmptyString,
  /**
   * For a desktop, the UI ↔ backend RPC version its backend speaks (`RPC_VERSION` in `@cerium/rpc`),
   * so other devices know whether they can drive it.
   */
  rpcVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type DeviceDraft = typeof DeviceDraft.Type;

/** A device as the account's approved devices see it. */
export const DeviceInfo = Schema.Struct({
  ...DeviceDraft.fields,
  id: DeviceId,
  /** Until an approved device allows it, a device sees and controls nothing. */
  approved: Schema.Boolean,
  /** It holds a connection to the relay right now. */
  online: Schema.Boolean,
  createdAt: EpochMillis,
  /** When its last connection opened or closed; absent until it first connects. */
  lastSeenAt: Schema.optionalKey(EpochMillis),
});
export type DeviceInfo = typeof DeviceInfo.Type;

/** Who the account belongs to, as the sign-in page reported it; for display only. */
export const AccountProfile = Schema.Struct({
  id: AccountId,
  name: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  imageUrl: Schema.optionalKey(Schema.String),
});
export type AccountProfile = typeof AccountProfile.Type;

/** The account as this machine knows it, for Settings → Account. */
export const AccountState = Schema.Union([
  Schema.TaggedStruct("SignedOut", {
    /** Why the last sign-in or connection ended, written for the user. */
    error: Schema.optionalKey(Schema.String),
  }),
  /** Waiting for the user to confirm in their browser, at `url`. */
  Schema.TaggedStruct("SigningIn", { url: Schema.String, expiresAt: EpochMillis }),
  Schema.TaggedStruct("SignedIn", {
    account: AccountProfile,
    deviceId: DeviceId,
    /** `offline` when the relay can't be reached; the devices are then the last ones it sent. */
    connection: Schema.Literals(["connecting", "online", "offline"]),
    /** Every device of the account, this one included; only this one until it is approved. */
    devices: Schema.Array(DeviceInfo),
  }),
]);
export type AccountState = typeof AccountState.Type;

// ---------------------------------------------------------------------------------------------
// The relay's API

/** `POST /api/links`: a machine starts signing in. */
export const CreateLinkRequest = Schema.Struct({
  device: DeviceDraft,
  /** SHA-256 of the device secret, hex; the relay never sees the secret until the device uses it. */
  secretHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type CreateLinkRequest = typeof CreateLinkRequest.Type;

export const CreateLinkResponse = Schema.Struct({ id: LinkId, url: Schema.String, expiresAt: EpochMillis });
export type CreateLinkResponse = typeof CreateLinkResponse.Type;

/** `GET /api/links/<id>`: what the sign-in page shows. */
export const LinkView = Schema.Struct({
  device: DeviceDraft,
  status: Schema.Literals(["pending", "confirmed"]),
  expiresAt: EpochMillis,
});
export type LinkView = typeof LinkView.Type;

/** `POST /api/links/<id>/confirm`, sent with the user's Clerk session token. */
export const ConfirmLinkRequest = Schema.Struct({
  profile: Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    email: Schema.optionalKey(Schema.String),
    imageUrl: Schema.optionalKey(Schema.String),
  }),
});
export type ConfirmLinkRequest = typeof ConfirmLinkRequest.Type;

export const ConfirmLinkResponse = Schema.Struct({ approved: Schema.Boolean });
export type ConfirmLinkResponse = typeof ConfirmLinkResponse.Type;

/** `POST /api/links/<id>/claim`, with the device secret: the account it joined, once confirmed. */
export const ClaimLinkResponse = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Linked", { account: AccountProfile, deviceId: DeviceId }),
]);
export type ClaimLinkResponse = typeof ClaimLinkResponse.Type;

/** `PATCH /api/devices/<id>`. */
export const RenameDeviceRequest = Schema.Struct({ name: DeviceName });

/** A refused request's body. `message` is written for the user. */
export const RelayError = Schema.Struct({ message: Schema.String });

// ---------------------------------------------------------------------------------------------
// Tunnels (docs/architecture.md §14.8): one device drives another's backend by sending it RPC
// frames through the relay, which passes them on without reading them.

/** One of a device's connections to the relay; replies go back to the connection that asked. */
export const ConnectionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/)).pipe(
  Schema.brand("cerium/ConnectionId"),
);
export type ConnectionId = typeof ConnectionId.Type;

/** A conversation between two connections, named by the one that starts it. */
export const ChannelId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));
export type ChannelId = typeof ChannelId.Type;

/** Where a frame goes: a desktop (its newest connection), or the connection that wrote first. */
export const TunnelAddress = Schema.Union([
  Schema.Struct({ device: DeviceId }),
  Schema.Struct({ connection: ConnectionId }),
]);
export type TunnelAddress = typeof TunnelAddress.Type;

/** Who a frame came from. */
export const TunnelPeer = Schema.Struct({ device: DeviceId, connection: ConnectionId });
export type TunnelPeer = typeof TunnelPeer.Type;

/** What a device sends its relay socket, besides `ping`: tunnel frames, and sync (§14.9). */
export const DeviceMessage = Schema.Union([
  ...SyncMessage.members,
  /** One RPC frame for the other end, as text. */
  Schema.TaggedStruct("Send", { to: TunnelAddress, channel: ChannelId, data: Schema.String }),
  /** This end of the channel is done. */
  Schema.TaggedStruct("Close", { to: TunnelAddress, channel: ChannelId }),
]);
export type DeviceMessage = typeof DeviceMessage.Type;

/**
 * What the relay sends a device's WebSocket: the account's current state after every change, and
 * `SignedOut` just before it closes the socket of a device that was removed or whose credential
 * isn't valid, so the device signs out even where the close handshake never completes. Tunnelled
 * frames arrive as `Receive` and `Closed`; `Undeliverable` says a frame found nobody to take it, and
 * `Gone` that a connection ended, so channels with it can end too.
 */
export const RelayMessage = Schema.Union([
  Schema.TaggedStruct("State", {
    account: AccountProfile,
    self: DeviceId,
    /** This socket's own connection, which tunnelled replies come back to. */
    connection: Schema.optionalKey(ConnectionId),
    /** Every device when this one is approved; only itself until then. */
    devices: Schema.Array(DeviceInfo),
  }),
  Schema.TaggedStruct("SignedOut", { reason: Schema.Literals(["removed", "invalid"]) }),
  Schema.TaggedStruct("Receive", { from: TunnelPeer, channel: ChannelId, data: Schema.String }),
  Schema.TaggedStruct("Closed", { from: TunnelPeer, channel: ChannelId }),
  Schema.TaggedStruct("Undeliverable", {
    channel: ChannelId,
    /** `offline`: the device isn't connected; `forbidden`: it isn't one this device may reach. */
    reason: Schema.Literals(["offline", "forbidden"]),
  }),
  Schema.TaggedStruct("Gone", { connection: ConnectionId }),
  ...SyncNotice.members,
]);
export type TunnelMessage = Extract<
  RelayMessage,
  { readonly _tag: "Receive" | "Closed" | "Undeliverable" | "Gone" }
>;
export type RelayMessage = typeof RelayMessage.Type;

/** The WebSocket subprotocol the relay speaks; the credential travels as a second one. */
export const RELAY_PROTOCOL = "cerium.v1";
const AUTH_PROTOCOL_PREFIX = "cerium.auth.";

/** Close codes that end a device's sign-in: it was removed, or its credential isn't valid. */
export const CLOSE_REMOVED = 4001;
export const CLOSE_BAD_CREDENTIAL = 4003;

/** How long a sign-in link waits for the user to confirm it. */
export const LINK_LIFETIME_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Device credentials: `cer1.<account>.<device>.<secret>`. Every part is base64url-safe, so the
// whole credential is a valid WebSocket subprotocol token.

export interface Credential {
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly secret: string;
}

const PART = /^[A-Za-z0-9_-]+$/;

export const formatCredential = ({ accountId, deviceId, secret }: Credential): string =>
  `cer1.${accountId}.${deviceId}.${secret}`;

export const parseCredential = (text: string): Credential | undefined => {
  const [version, accountId, deviceId, secret, ...rest] = text.split(".");
  if (version !== "cer1" || rest.length > 0) return undefined;
  if (accountId === undefined || deviceId === undefined || secret === undefined) return undefined;
  if (![accountId, deviceId, secret].every((part) => PART.test(part))) return undefined;
  return { accountId: accountId as AccountId, deviceId: deviceId as DeviceId, secret };
};

/** `bytes` random bytes as base64url, for device secrets and ids nobody can guess. */
export const randomToken = (bytes: number): string => {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...values))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

/** SHA-256 of a device secret, hex: all the relay keeps of it. */
export const hashSecret = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The subprotocols a device offers when it connects. */
export const relayProtocols = (credential: Credential): Array<string> => [
  RELAY_PROTOCOL,
  `${AUTH_PROTOCOL_PREFIX}${formatCredential(credential)}`,
];

/** The credential a device offered in its `Sec-WebSocket-Protocol` header. */
export const credentialFromProtocols = (header: string | null): Credential | undefined => {
  const offered = (header ?? "").split(",").map((protocol) => protocol.trim());
  if (!offered.includes(RELAY_PROTOCOL)) return undefined;
  const auth = offered.find((protocol) => protocol.startsWith(AUTH_PROTOCOL_PREFIX));
  return auth === undefined ? undefined : parseCredential(auth.slice(AUTH_PROTOCOL_PREFIX.length));
};
