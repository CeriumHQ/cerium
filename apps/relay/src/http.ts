import { CLOSE_BAD_CREDENTIAL, CLOSE_REMOVED, RELAY_PROTOCOL, type RelayMessage } from "@cerium/protocol";
import { Option, Schema } from "effect";

// Small helpers for the relay's JSON API. Refusals carry a `message` written for the user, which
// the backend shows as it is.

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export const refuse = (status: number, message: string): Response => json({ message }, status);

/** The bearer token a request carries, if any. */
export const bearer = (request: Request): string | undefined => {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || undefined : undefined;
};

/** The request's JSON body decoded with `schema`; none when it's missing, not JSON or doesn't match. */
export const readBody = async <S extends Schema.ConstraintDecoder<unknown>>(
  request: Request,
  schema: S,
): Promise<S["Type"] | undefined> => {
  const body: unknown = await request.json().catch(() => undefined);
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(body));
};

/** A request's path parameter decoded with `schema`. */
export const param = <S extends Schema.ConstraintDecoder<unknown>>(
  value: unknown,
  schema: S,
): S["Type"] | undefined => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

type SignOutReason = Extract<RelayMessage, { readonly _tag: "SignedOut" }>["reason"];

const signOutClose: Record<SignOutReason, readonly [number, string]> = {
  removed: [CLOSE_REMOVED, "This device was removed from your account."],
  invalid: [CLOSE_BAD_CREDENTIAL, "This device's sign-in isn't valid."],
};

/** Tells a device it's signed out, and why, then closes its socket with the matching code. */
export const signOut = (socket: WebSocket, reason: SignOutReason) => {
  try {
    socket.send(JSON.stringify({ _tag: "SignedOut", reason } satisfies RelayMessage));
    socket.close(...signOutClose[reason]);
  } catch {
    // Already closing.
  }
};

/**
 * The socket of a device the relay refuses, signed out at once: a browser can't read why an upgrade
 * was refused, but it can read a message and a close code.
 */
export const refusedSocket = (reason: SignOutReason): Response => {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  signOut(server, reason);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL },
  });
};
