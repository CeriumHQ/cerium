import type { AccountState, DeviceInfo } from "@cerium/protocol";
import { MIN_RPC_VERSION } from "@cerium/rpc";

import { WEB } from "../../backend/target.ts";
import { whenAgo } from "../../lib/time.ts";

// What the UI says about the account and its devices (docs/architecture.md §14), as plain functions.

type SignedIn = Extract<AccountState, { _tag: "SignedIn" }>;

const PLATFORMS: Readonly<Record<string, string>> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
};

export const platformLabel = (platform: string) => PLATFORMS[platform] ?? platform;

/** "Windows · Nightly · 0.4.0": enough to tell a device apart; development builds say so. */
export const deviceDetails = (device: DeviceInfo): string =>
  [
    platformLabel(device.platform),
    device.kind === "browser" ? "Web app" : undefined,
    device.channel === "nightly" ? "Nightly" : device.channel === "dev" ? "Development build" : undefined,
    device.version === "dev" ? undefined : device.version,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/** What the UI calls the device it runs on: a desktop's UI runs on a computer, the web client doesn't. */
export const selfNoun = WEB ? "device" : "computer";

/** This machine, among the account's devices. */
export const thisDevice = (account: SignedIn): DeviceInfo | undefined =>
  account.devices.find((device) => device.id === account.deviceId);

/** Whether this machine may see and control the account yet. */
export const isApproved = (account: SignedIn) => thisDevice(account)?.approved === true;

/**
 * Other devices waiting for this one to let them in: only an approved device sees them, and only
 * while it's connected, since allowing one takes the relay.
 */
export const waitingDevices = (account: AccountState): ReadonlyArray<DeviceInfo> =>
  account._tag === "SignedIn" && account.connection === "online" && isApproved(account)
    ? account.devices.filter((device) => !device.approved && device.id !== account.deviceId)
    : [];

/**
 * The account's devices: this one first, then the rest in the order they joined. Allowing or
 * renaming one never moves it, so rows don't shift under the pointer.
 */
export const orderedDevices = (account: SignedIn): ReadonlyArray<DeviceInfo> =>
  account.devices.toSorted(
    (a, b) =>
      Number(b.id === account.deviceId) - Number(a.id === account.deviceId) || a.createdAt - b.createdAt,
  );

/** "Online", "Last seen 5 minutes ago", "Last seen yesterday", or "Never connected". */
export const presenceLabel = (device: DeviceInfo, now = Date.now()): string => {
  if (device.online) return "Online";
  if (device.lastSeenAt === undefined) return "Never connected";
  return `Last seen ${whenAgo(device.lastSeenAt, now)}`;
};

/** Whether another desktop can be driven from here right now (§14.8). */
export type Reach =
  | { readonly kind: "reachable" }
  /** Its backend is too old for this UI. */
  | { readonly kind: "outdated" }
  /** It isn't connected; `presence` says since when. */
  | { readonly kind: "offline"; readonly presence: string };

export const reachOf = (device: DeviceInfo, now = Date.now()): Reach =>
  (device.rpcVersion ?? 0) < MIN_RPC_VERSION
    ? { kind: "outdated" }
    : device.online
      ? { kind: "reachable" }
      : { kind: "offline", presence: presenceLabel(device, now) };

/** Why another desktop can't be driven from here right now, or nothing when it can. */
export const whyUnreachable = (device: DeviceInfo, now = Date.now()): string | undefined => {
  const reach = reachOf(device, now);
  return reach.kind === "outdated"
    ? "Update Cerium there to reach it"
    : reach.kind === "offline"
      ? reach.presence
      : undefined;
};

/** Up to two initials for an account without a picture. */
export const initials = (name: string | undefined, email: string | undefined): string => {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 0)
    return words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("");
  return (email ?? "?").charAt(0).toUpperCase();
};
