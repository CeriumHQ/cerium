import type { PushSubscriptionInfo } from "@cerium/protocol";

// Web Push from the relay, on WebCrypto alone: each notification is
// encrypted for the browser's subscription (RFC 8291, one aes128gcm record) and signed for the push
// service with the relay's VAPID key (RFC 8292).

const encoder = new TextEncoder();

/** UTF-8 bytes in a buffer of their own, as WebCrypto takes them. */
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * The relay's VAPID key pair as `scripts/vapid.ts` makes it, base64url: the public key as an
 * uncompressed P-256 point, the private key as its scalar. `subject` is how push services reach
 * whoever runs the relay: an `https:` or `mailto:` URL.
 */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

/** A P-256 key as a JWK, from its uncompressed public point and, for a private key, its scalar. */
export const p256Jwk = (publicKey: Uint8Array, d?: string): JsonWebKey => ({
  kty: "EC",
  crv: "P-256",
  x: toBase64Url(publicKey.slice(1, 33)),
  y: toBase64Url(publicKey.slice(33, 65)),
  ...(d === undefined ? {} : { d }),
});

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8),
  );
};

/** The key pair one message is encrypted with, made fresh for each one. */
export interface SenderKey {
  readonly privateKey: CryptoKey;
  /** Uncompressed P-256 point. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
}

const freshSenderKey = async (): Promise<SenderKey> => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(raw) };
};

/** One record holds a whole notification: push services take at least 4096 bytes. */
const RECORD_SIZE = 4096;

/**
 * `plaintext` encrypted for a subscription's keys (RFC 8291): the aes128gcm header, then one record.
 * `salt` and `sender` are random unless given, which only tests do.
 */
export const encryptPayload = async (
  keys: PushSubscriptionInfo["keys"],
  plaintext: Uint8Array,
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
  sender?: SenderKey,
): Promise<Uint8Array<ArrayBuffer>> => {
  const browserKey = fromBase64Url(keys.p256dh);
  const local = sender ?? (await freshSenderKey());
  const browser = await crypto.subtle.importKey(
    "raw",
    browserKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // The Workers types call `public` `$public`, after its C++ name; the runtime reads `public`.
  const agreement = { name: "ECDH", public: browser };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(agreement, local.privateKey, 256));
  const ikm = await hkdf(
    fromBase64Url(keys.auth),
    shared,
    concat(utf8("WebPush: info\0"), browserKey, local.publicKey),
    32,
  );
  const contentKey = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  // The last (and only) record ends with the delimiter 2, unpadded.
  const record = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aes,
    concat(plaintext, Uint8Array.of(2)),
  );
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = local.publicKey.length;
  return concat(header, local.publicKey, new Uint8Array(record));
};

/** How long a push service may trust the relay's signature: push services take up to a day. */
const SIGNATURE_LIFETIME_S = 12 * 60 * 60;

/** The `Authorization` header for a push service (RFC 8292): a JWT for its origin, signed with the VAPID key. */
export const vapidAuthorization = async (endpoint: string, vapid: VapidKeys, now = Date.now()) => {
  const part = (value: object) => toBase64Url(utf8(JSON.stringify(value)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + SIGNATURE_LIFETIME_S,
    sub: vapid.subject,
  })}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(fromBase64Url(vapid.publicKey), vapid.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned));
  return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${vapid.publicKey}`;
};

export interface PushOptions {
  /** Seconds the push service keeps it for a browser that's offline. */
  readonly ttl: number;
  readonly urgency: "high" | "normal";
  /** A newer push with the same topic replaces one the browser hasn't had yet. */
  readonly topic?: string;
}

/** What came of a push: sent, refused for good (the subscription is gone), or failed this once. */
export type PushResult = "sent" | "gone" | "failed";

/** Sends `payload` to a browser through its push service. */
export const sendPush = async (
  subscription: PushSubscriptionInfo,
  payload: string,
  vapid: VapidKeys,
  options: PushOptions,
  fetcher: typeof fetch = fetch,
): Promise<PushResult> => {
  const response = await fetcher(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttl),
      Urgency: options.urgency,
      ...(options.topic === undefined ? {} : { Topic: options.topic }),
    },
    body: await encryptPayload(subscription.keys, utf8(payload)),
  });
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) return "gone";
  return response.ok ? "sent" : "failed";
};

/** A push topic for a thread: base64url, at most 32 characters, as RFC 8030 allows. */
export const pushTopic = async (key: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(key)))).slice(0, 32);
