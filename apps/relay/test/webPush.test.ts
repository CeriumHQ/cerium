import { describe, expect, it } from "@effect/vitest";

import {
  encryptPayload,
  fromBase64Url,
  p256Jwk,
  pushTopic,
  sendPush,
  toBase64Url,
  vapidAuthorization,
  type VapidKeys,
} from "../src/webPush.ts";

// The example in RFC 8291 §5 and Appendix A: a browser's keys, the sender's, the salt, and what
// encrypting "When I grow up, I want to be a watermelon" with them must give.
const rfc = {
  plaintext: "When I grow up, I want to be a watermelon",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const ecdhKey = (publicKey: string, privateKey: string) =>
  crypto.subtle.importKey(
    "jwk",
    p256Jwk(fromBase64Url(publicKey), privateKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: string,
  bytes: number,
) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
      await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
      bytes * 8,
    ),
  );

/** What the browser does with a push: the receiving side of RFC 8291, with the RFC's browser keys. */
const decrypt = async (body: Uint8Array<ArrayBuffer>): Promise<string> => {
  const salt = body.slice(0, 16);
  const keyLength = body[20]!;
  const senderKey = body.slice(21, 21 + keyLength);
  const record = body.slice(21 + keyLength);
  const sender = await crypto.subtle.importKey(
    "raw",
    senderKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const agreement = { name: "ECDH", public: sender };
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(agreement, await ecdhKey(rfc.receiverPublic, rfc.receiverPrivate), 256),
  );
  const receiver = fromBase64Url(rfc.receiverPublic);
  const info = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...receiver, ...senderKey]);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: fromBase64Url(rfc.auth), info },
      await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]),
      256,
    ),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12) },
      key,
      record,
    ),
  );
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
};

const keys = { p256dh: rfc.receiverPublic, auth: rfc.auth };

/** A VAPID key pair made for the test, as scripts/vapid.ts makes the relay's. */
const makeVapid = async (): Promise<VapidKeys> => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: toBase64Url(raw), privateKey: jwk.d!, subject: "https://cerium.example" };
};

describe("encrypting a push for a browser", () => {
  it("gives RFC 8291's example message for its keys and salt", async () => {
    const body = await encryptPayload(
      keys,
      new TextEncoder().encode(rfc.plaintext),
      fromBase64Url(rfc.salt),
      {
        privateKey: await ecdhKey(rfc.senderPublic, rfc.senderPrivate),
        publicKey: fromBase64Url(rfc.senderPublic),
      },
    );
    expect(toBase64Url(body)).toBe(rfc.body);
  });

  it("uses a fresh key and salt for each message, which the browser decrypts", async () => {
    const first = await encryptPayload(keys, new TextEncoder().encode("Finished"));
    const second = await encryptPayload(keys, new TextEncoder().encode("Finished"));
    expect(toBase64Url(first)).not.toBe(toBase64Url(second));
    expect(await decrypt(first)).toBe("Finished");
    expect(await decrypt(second)).toBe("Finished");
  });
});

describe("signing for a push service", () => {
  it("signs a JWT for the endpoint's origin that the relay's public key verifies", async () => {
    const vapid = await makeVapid();
    const now = Date.UTC(2026, 9, 18, 12);
    const header = await vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMqJ8F/abc", vapid, now);
    const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(publicKey).toBe(vapid.publicKey);
    const [head, claims, signature] = token!.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(head!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims!)))).toEqual({
      aud: "https://web.push.apple.com",
      exp: now / 1000 + 12 * 60 * 60,
      sub: "https://cerium.example",
    });
    const verifier = await crypto.subtle.importKey(
      "jwk",
      p256Jwk(fromBase64Url(vapid.publicKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifier,
      fromBase64Url(signature!),
      new TextEncoder().encode(`${head}.${claims}`),
    );
    expect(valid).toBe(true);
  });
});

describe("sending a push", () => {
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys };

  const answering = (status: number) => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { requests, fetcher };
  };

  it("posts the encrypted payload with the push service's headers", async () => {
    const vapid = await makeVapid();
    const { requests, fetcher } = answering(201);
    const result = await sendPush(
      subscription,
      '{"title":"Fix the login redirect"}',
      vapid,
      { ttl: 86_400, urgency: "high", topic: "abc" },
      fetcher,
    );
    expect(result).toBe("sent");
    const [request] = requests;
    expect(request?.url).toBe(subscription.endpoint);
    const headers = request?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      Urgency: "high",
      Topic: "abc",
    });
    expect(headers["Authorization"]).toMatch(/^vapid t=/);
    expect(await decrypt(request?.init.body as Uint8Array<ArrayBuffer>)).toBe(
      '{"title":"Fix the login redirect"}',
    );
  });

  it("tells a subscription that's gone from one that failed this once", async () => {
    const vapid = await makeVapid();
    const options = { ttl: 60, urgency: "normal" } as const;
    expect(await sendPush(subscription, "{}", vapid, options, answering(410).fetcher)).toBe("gone");
    expect(await sendPush(subscription, "{}", vapid, options, answering(404).fetcher)).toBe("gone");
    expect(await sendPush(subscription, "{}", vapid, options, answering(429).fetcher)).toBe("failed");
  });

  it("names a thread's pushes with a short topic of its own", async () => {
    const topic = await pushTopic("machine:thread");
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await pushTopic("machine:thread")).toBe(topic);
    expect(await pushTopic("machine:other")).not.toBe(topic);
  });
});
