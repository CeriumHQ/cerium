import {
  hashSecret,
  LINK_CALLBACK_PATH,
  randomToken,
  type AccountId,
  type AccountProfile,
  type ConfirmLinkRequest,
  type CreateLinkRequest,
  type DeviceDraft,
  type DeviceId,
  type Installation,
  type LinkCallback,
  type LinkId,
  type LinkView,
} from "@cerium/protocol";

// What a pending sign-in may do, as plain functions over its record, so they're tested without the
// Workers runtime. Anyone can start a sign-in, so confirming one in a browser doesn't let the device
// in: it hands the page a one-time code, which the page passes only to a device beside it (a
// desktop's loopback listener, or the web client on this origin), and the device joins once it
// claims the link with its secret and that code. A link someone else started and sent the user
// takes the code to the user's own computer, where nothing is waiting for it.

export interface Pending {
  readonly device: DeviceDraft;
  readonly secretHash: string;
  readonly installation?: Installation;
  readonly callback?: LinkCallback;
  readonly expiresAt: number;
  /** Confirmed in a browser: by whom, and the hash of the code that finishes it. */
  readonly approved?: {
    readonly account: AccountProfile;
    readonly codeHash: string;
  };
  readonly linked?: {
    readonly account: AccountProfile;
    readonly deviceId: DeviceId;
  };
}

export type Refusal = { readonly ok: false; readonly status: number; readonly message: string };

const refusal = (status: number, message: string): Refusal => ({ ok: false, status, message });

/** A new sign-in, or why the relay won't start it. */
export const startLink = (request: CreateLinkRequest, expiresAt: number): Pending | Refusal => {
  if (request.device.kind === "desktop" && request.callback === undefined)
    return refusal(426, "This version of Cerium can't sign in anymore. Update Cerium, then sign in again.");
  if (request.device.kind === "browser" && request.callback !== undefined)
    return refusal(400, "That sign-in request isn't one the relay understands.");
  return {
    device: request.device,
    secretHash: request.secretHash,
    ...(request.installation === undefined ? {} : { installation: request.installation }),
    ...(request.callback === undefined ? {} : { callback: request.callback }),
    expiresAt,
  };
};

export const viewOf = (link: Pending): LinkView => ({
  device: link.device,
  status: link.linked !== undefined ? "confirmed" : link.approved !== undefined ? "approved" : "pending",
  expiresAt: link.expiresAt,
});

/**
 * Where the page takes the code once the user confirms: the desktop's loopback listener, or the web
 * client on the page's own origin. Built here from what the link was started with, never from what
 * the page is told, so no link can send its code anywhere else.
 */
export const handoffUrl = (id: LinkId, link: Pending, code: string): string => {
  const query = `link=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}`;
  return link.callback === undefined
    ? `/app/#cerium-link=${encodeURIComponent(id)}.${encodeURIComponent(code)}`
    : `http://127.0.0.1:${link.callback.port}${LINK_CALLBACK_PATH}?${query}`;
};

/**
 * The user, signed in, lets the device into their account: the link takes a fresh code, which only
 * the device the page hands it to can use. Confirming again from the same account replaces it, for
 * when the first never arrived; no other account may confirm it then.
 */
export const approve = async (
  link: Pending,
  accountId: AccountId,
  profile: ConfirmLinkRequest["profile"],
): Promise<{ readonly ok: true; readonly link: Pending; readonly code: string } | Refusal> => {
  const owner = link.linked?.account.id ?? link.approved?.account.id;
  if (owner !== undefined && owner !== accountId)
    return refusal(409, "This machine was already connected to another account.");
  if (link.linked !== undefined) return refusal(409, "This machine is connected already.");
  const code = randomToken(32);
  return {
    ok: true,
    code,
    link: { ...link, approved: { account: { id: accountId, ...profile }, codeHash: await hashSecret(code) } },
  };
};

/**
 * What a device's claim gets: `wait` until the user confirms; `join` the account the user confirmed
 * it into, with the right secret and code; `linked`, again, once it joined; `forbidden` without the
 * secret; `burn` with a wrong code, which ends the link, since only someone guessing sends one.
 */
export type Claim =
  | { readonly _tag: "wait" }
  | { readonly _tag: "join"; readonly account: AccountProfile }
  | { readonly _tag: "linked"; readonly account: AccountProfile; readonly deviceId: DeviceId }
  | { readonly _tag: "forbidden" }
  | { readonly _tag: "burn" };

export const claim = async (link: Pending, secret: string, code: string | undefined): Promise<Claim> => {
  if ((await hashSecret(secret)) !== link.secretHash) return { _tag: "forbidden" };
  if (link.linked !== undefined) return { _tag: "linked", ...link.linked };
  if (code === undefined) return { _tag: "wait" };
  if (link.approved === undefined || (await hashSecret(code)) !== link.approved.codeHash)
    return { _tag: "burn" };
  return { _tag: "join", account: link.approved.account };
};
