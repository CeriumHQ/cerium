import {
  hashSecret,
  LINK_CALLBACK_PATH,
  randomToken,
  type AccountId,
  type AccountProfile,
  type ConfirmLinkRequest,
  type ConfirmLinkResponse,
  type CreateLinkRequest,
  type DeviceDraft,
  type DeviceId,
  type Installation,
  type LinkCallback,
  type LinkId,
  type LinkHandoffMode,
  type LinkView,
} from "@cerium/protocol";

// Anyone can start a sign-in. Only the confirming page learns its one-time code. The device must
// receive that code over loopback, on the web client's own origin, or from its user's terminal,
// and present it with its original secret before it can join the account.

export interface Pending {
  readonly device: DeviceDraft;
  readonly secretHash: string;
  readonly installation?: Installation;
  readonly callback?: LinkCallback;
  readonly handoff?: LinkHandoffMode;
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
  if (request.device.kind === "desktop" && request.callback === undefined && request.handoff !== "manual")
    return refusal(426, "This version of Cerium can't sign in anymore. Update Cerium, then sign in again.");
  if (
    (request.device.kind === "browser" &&
      (request.callback !== undefined || request.handoff !== undefined)) ||
    (request.handoff === "manual" && request.callback !== undefined)
  )
    return refusal(400, "That sign-in request isn't one the relay understands.");
  return {
    device: request.device,
    secretHash: request.secretHash,
    ...(request.handoff === undefined ? {} : { handoff: request.handoff }),
    ...(request.installation === undefined ? {} : { installation: request.installation }),
    ...(request.callback === undefined ? {} : { callback: request.callback }),
    expiresAt,
  };
};

export const viewOf = (link: Pending): LinkView => ({
  device: link.device,
  ...(link.handoff === undefined ? {} : { handoff: link.handoff }),
  status: link.linked !== undefined ? "confirmed" : link.approved !== undefined ? "approved" : "pending",
  expiresAt: link.expiresAt,
});

/**
 * The confirming page shows a terminal code or redirects to a trusted destination derived from
 * the original request: a desktop's loopback listener or the web client on the page's origin.
 */
export const confirmation = (id: LinkId, link: Pending, code: string): ConfirmLinkResponse => {
  if (link.handoff === "manual") return { code };
  const query = `link=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}`;
  const next =
    link.callback === undefined
      ? `/app/#cerium-link=${encodeURIComponent(id)}.${encodeURIComponent(code)}`
      : `http://127.0.0.1:${link.callback.port}${LINK_CALLBACK_PATH}?${query}`;
  return { next };
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
