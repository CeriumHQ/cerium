import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import {
  buildFromQuery,
  buildQuery,
  credentialFromProtocols,
  DeviceDraft,
  formatCredential,
  hashSecret,
  parseCredential,
  randomToken,
  relayProtocols,
  type AccountId,
  type DeviceId,
} from "../src/index.ts";

const credential = {
  accountId: "user_2abcDEF" as AccountId,
  deviceId: "dQw4w9WgXcQ-_x" as DeviceId,
  secret: "c2VjcmV0LXNlY3JldA_-",
};

describe("device credentials", () => {
  it("round-trips through their text form", () => {
    const text = formatCredential(credential);
    expect(text).toBe("cer1.user_2abcDEF.dQw4w9WgXcQ-_x.c2VjcmV0LXNlY3JldA_-");
    expect(parseCredential(text)).toEqual(credential);
  });

  it("refuses other versions, missing or extra parts and characters outside base64url", () => {
    expect(parseCredential("cer2.user.device.secret")).toBeUndefined();
    expect(parseCredential("cer1.user.device")).toBeUndefined();
    expect(parseCredential("cer1.user.device.secret.more")).toBeUndefined();
    expect(parseCredential("cer1.user.dev ice.secret")).toBeUndefined();
    expect(parseCredential("cer1..device.secret")).toBeUndefined();
  });

  it("travels as a WebSocket subprotocol beside the relay's own", () => {
    const header = relayProtocols(credential).join(", ");
    expect(credentialFromProtocols(header)).toEqual(credential);
    // Without the relay's protocol, or without a credential, nothing is offered.
    expect(credentialFromProtocols(`cerium.auth.${formatCredential(credential)}`)).toBeUndefined();
    expect(credentialFromProtocols("cerium.v1")).toBeUndefined();
    expect(credentialFromProtocols(null)).toBeUndefined();
  });
});

describe("secrets", () => {
  it("are base64url without padding", () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(token);
  });

  it("hash to lowercase hex SHA-256", async () => {
    expect(await hashSecret("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("DeviceDraft", () => {
  const draft = {
    kind: "desktop",
    name: "Studio PC",
    platform: "win32",
    channel: "stable",
    version: "0.4.0",
  };
  const decode = Schema.decodeUnknownOption(DeviceDraft);

  it("takes a machine's own description", () => {
    expect(Option.isSome(decode(draft))).toBe(true);
  });

  it("refuses names that are empty, padded or longer than 64 characters", () => {
    expect(Option.isNone(decode({ ...draft, name: "" }))).toBe(true);
    expect(Option.isNone(decode({ ...draft, name: " Studio PC" }))).toBe(true);
    expect(Option.isNone(decode({ ...draft, name: "x".repeat(65) }))).toBe(true);
  });
});

describe("a device's build", () => {
  it("travels in the query it connects with", () => {
    const build = { version: "0.3.0-nightly.14", rpcVersion: 2 };
    expect(buildFromQuery(new URLSearchParams(buildQuery(build)))).toEqual(build);
    expect(buildFromQuery(new URLSearchParams(buildQuery({ version: "0.3.0" })))).toEqual({
      version: "0.3.0",
    });
  });

  it("is left alone when a device reports none, or one that isn't valid", () => {
    expect(buildFromQuery(new URLSearchParams())).toBeUndefined();
    expect(buildFromQuery(new URLSearchParams("version="))).toBeUndefined();
    expect(buildFromQuery(new URLSearchParams("version=0.3.0&rpcVersion=0"))).toBeUndefined();
    expect(buildFromQuery(new URLSearchParams("version=0.3.0&rpcVersion=two"))).toBeUndefined();
  });
});
