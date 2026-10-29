import { credentialFromProtocols, parseCredential, type Credential } from "@cerium/protocol";

import { bearer, refuse } from "./http.ts";

// How often a client may call the relay's API, with Workers Rate Limiting bindings (`ratelimits`
// in wrangler.jsonc). Requests without a device credential count against their address; a device's
// requests against the device, so one account can't use up another's, and against its address too,
// since the credential is only checked once the request reaches the account's object. A device's
// tunnel and sync traffic travel over its socket, which these limits never see: only opening it counts.
// Counts are kept per Cloudflare location and are approximate, so the limits sit well above normal use.

/** The relay's rate limiters (wrangler.jsonc). */
export interface Limiters {
  /** Starting a sign-in, per address. */
  readonly SIGN_IN_LIMIT: RateLimit;
  /** Any other request without a device credential (sign-in page, polling for a link), per address. */
  readonly PUBLIC_LIMIT: RateLimit;
  /** Every request with a device credential, per address. */
  readonly ADDRESS_LIMIT: RateLimit;
  /** A device's requests: reading threads, renaming and removing devices. */
  readonly DEVICE_LIMIT: RateLimit;
  /** A device opening its live connection. */
  readonly CONNECT_LIMIT: RateLimit;
  /** A connected assistant's calls to the MCP endpoint, per assistant. */
  readonly ASSISTANT_LIMIT: RateLimit;
}

type Limiter = keyof Limiters;

/** Each limiter's period in seconds, as wrangler.jsonc sets it: how long a refused client waits. */
export const PERIODS: Record<Limiter, 10 | 60> = {
  SIGN_IN_LIMIT: 60,
  PUBLIC_LIMIT: 10,
  ADDRESS_LIMIT: 10,
  DEVICE_LIMIT: 10,
  CONNECT_LIMIT: 60,
  ASSISTANT_LIMIT: 10,
};

interface Check {
  readonly limiter: Limiter;
  readonly key: string;
}

/** The device a request says it comes from; the account's object checks the claim. */
const deviceOf = (request: Request, resource: string | undefined): Credential | undefined =>
  resource === "connect"
    ? credentialFromProtocols(request.headers.get("Sec-WebSocket-Protocol"))
    : resource === "sync" || resource === "devices" || resource === "assistants"
      ? parseCredential(bearer(request) ?? "")
      : undefined;

/** The limits a request to `/api/<resource>/<id>` counts against, in the order they're checked. */
export const checksFor = (
  request: Request,
  resource: string | undefined,
  id: string | undefined,
): ReadonlyArray<Check> => {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (resource === "links" && id === undefined && request.method === "POST")
    return [{ limiter: "SIGN_IN_LIMIT", key: address }];
  const device = deviceOf(request, resource);
  if (device === undefined) return [{ limiter: "PUBLIC_LIMIT", key: address }];
  return [
    { limiter: "ADDRESS_LIMIT", key: address },
    {
      limiter: resource === "connect" ? "CONNECT_LIMIT" : "DEVICE_LIMIT",
      key: `${device.accountId}/${device.deviceId}`,
    },
  ];
};

/** A 429 in the relay's usual shape, saying when to try again. */
export const tooMany = (seconds: number): Response => {
  const response = refuse(
    429,
    `Too many requests to Cerium's cloud. Try again in ${seconds < 60 ? "a few seconds" : "a minute"}.`,
  );
  response.headers.set("Retry-After", String(seconds));
  return response;
};

/** The refusal for a request over one of its limits, or none when it may go ahead. */
export const limit = async (
  limiters: Limiters,
  request: Request,
  resource: string | undefined,
  id: string | undefined,
): Promise<Response | undefined> => {
  for (const { limiter, key } of checksFor(request, resource, id)) {
    const { success } = await limiters[limiter].limit({ key });
    if (!success) return tooMany(PERIODS[limiter]);
  }
  return undefined;
};
