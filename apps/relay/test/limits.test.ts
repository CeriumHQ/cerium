import { formatCredential, relayProtocols, type AccountId, type DeviceId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { limit, PERIODS, type Limiters } from "../src/limits.ts";

/** A limiter allowing `allowed` calls per key, as the binding does within one period. */
const limiter = (allowed: number): RateLimit => {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= allowed };
    },
  };
};

const limiters = (allowed = 3): Limiters => ({
  SIGN_IN_LIMIT: limiter(allowed),
  PUBLIC_LIMIT: limiter(allowed),
  ADDRESS_LIMIT: limiter(allowed * 10),
  DEVICE_LIMIT: limiter(allowed),
  CONNECT_LIMIT: limiter(allowed),
});

const credential = (deviceId: string) => ({
  accountId: "user_1" as AccountId,
  deviceId: deviceId as DeviceId,
  secret: "secret",
});

const request = (
  path: string,
  init: { method?: string; ip?: string; headers?: Record<string, string> } = {},
) =>
  new Request(`https://relay.test${path}`, {
    method: init.method ?? "GET",
    headers: { "CF-Connecting-IP": init.ip ?? "203.0.113.1", ...init.headers },
  });

const fromDevice = (path: string, deviceId: string, ip?: string) =>
  request(path, {
    ...(ip === undefined ? {} : { ip }),
    headers: { Authorization: `Bearer ${formatCredential(credential(deviceId))}` },
  });

const connect = (deviceId: string) =>
  request("/api/connect", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": relayProtocols(credential(deviceId)).join(", "),
    },
  });

/** Sends `make()` `times` times and returns the last answer. */
const send = async (limits: Limiters, make: () => Request, times: number) => {
  let last: Response | undefined;
  for (let i = 0; i < times; i++) {
    const each = make();
    const [, , resource, id] = new URL(each.url).pathname.split("/");
    last = await limit(limits, each, resource, id);
  }
  return last;
};

describe("the relay's rate limits", () => {
  it("lets requests under the limit through and refuses the next with 429 and Retry-After", async () => {
    const limits = limiters();
    const startSignIn = () => request("/api/links", { method: "POST" });
    expect(await send(limits, startSignIn, 3)).toBeUndefined();
    const refused = await send(limits, startSignIn, 1);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBe(String(PERIODS.SIGN_IN_LIMIT));
    expect(await refused?.json()).toEqual({
      message: "Too many requests to Cerium's cloud. Try again in a minute.",
    });
  });

  it("counts requests without a device credential against their address", async () => {
    const limits = limiters();
    const startSignIn = (ip: string) => () => request("/api/links", { method: "POST", ip });
    await send(limits, startSignIn("203.0.113.1"), 3);
    expect((await send(limits, startSignIn("203.0.113.1"), 1))?.status).toBe(429);
    expect(await send(limits, startSignIn("203.0.113.2"), 1)).toBeUndefined();
    // Polling a link is limited apart from starting one.
    const poll = () => request("/api/links/abc/claim", { method: "POST" });
    expect(await send(limits, poll, 3)).toBeUndefined();
    const refused = await send(limits, poll, 1);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("Retry-After")).toBe(String(PERIODS.PUBLIC_LIMIT));
  });

  it("counts a device's requests against the device, so another one isn't held up", async () => {
    const limits = limiters();
    const read = (deviceId: string) => () => fromDevice("/api/sync/desk/thread", deviceId);
    expect(await send(limits, read("laptop"), 3)).toBeUndefined();
    expect((await send(limits, read("laptop"), 1))?.status).toBe(429);
    // Same address, other device.
    expect(await send(limits, read("phone"), 3)).toBeUndefined();
    // Reads don't use up a device's connections.
    expect(await send(limits, () => connect("laptop"), 3)).toBeUndefined();
    expect((await send(limits, () => connect("laptop"), 1))?.status).toBe(429);
  });

  it("caps an address's credentialed requests, however many devices they claim", async () => {
    const limits = limiters();
    let n = 0;
    const forged = () => fromDevice("/api/sync/desk/thread", `forged${n++}`);
    expect(await send(limits, forged, 30)).toBeUndefined();
    expect((await send(limits, forged, 1))?.status).toBe(429);
    expect(
      await send(limits, () => fromDevice("/api/sync/desk/thread", "laptop", "198.51.100.7"), 1),
    ).toBeUndefined();
  });

  it("treats a credential that doesn't parse as no credential", async () => {
    const limits = limiters();
    const bad = () =>
      request("/api/devices/laptop", { method: "DELETE", headers: { Authorization: "Bearer nonsense" } });
    expect(await send(limits, bad, 3)).toBeUndefined();
    expect((await send(limits, bad, 1))?.headers.get("Retry-After")).toBe(String(PERIODS.PUBLIC_LIMIT));
  });
});
