import type { AccountId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  allowsRedirect,
  formatToken,
  isRedirectUri,
  parseToken,
  readAuthorize,
  registerClient,
  resolveClient,
  verifiesChallenge,
} from "../src/oauth.ts";

const ISSUER = "https://cerium.example";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const challengeOf = async (verifier: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

const VERIFIER = "a".repeat(43) + "-._~";

const registered = (redirectUris: ReadonlyArray<string>, name = "Grok") => {
  const answer = registerClient({ client_name: name, redirect_uris: redirectUris });
  if (!("client_id" in answer)) throw new Error(answer.error_description);
  return answer.client_id;
};

const authorizeQuery = async (clientId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://grok.example/callback",
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: "S256",
    state: "xyz",
    ...extra,
  });

describe("redirect URIs", () => {
  it("takes https, loopback http and an app's own scheme", () => {
    expect(isRedirectUri("https://grok.example/callback")).toBe(true);
    expect(isRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isRedirectUri("http://localhost/cb")).toBe(true);
    expect(isRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(true);
  });

  it("refuses plain http elsewhere, fragments, and schemes a page must never go to", () => {
    expect(isRedirectUri("http://grok.example/callback")).toBe(false);
    expect(isRedirectUri("https://grok.example/callback#frag")).toBe(false);
    expect(isRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isRedirectUri("data:text/html,hi")).toBe(false);
    expect(isRedirectUri("not a url")).toBe(false);
  });

  it("matches exactly, or a loopback one on any port", () => {
    const client = { id: "c", name: "App", redirectUris: ["https://a.example/cb", "http://127.0.0.1/cb"] };
    expect(allowsRedirect(client, "https://a.example/cb")).toBe(true);
    expect(allowsRedirect(client, "https://a.example/cb2")).toBe(false);
    expect(allowsRedirect(client, "http://127.0.0.1:50123/cb")).toBe(true);
    expect(allowsRedirect(client, "http://127.0.0.1:50123/other")).toBe(false);
  });
});

describe("registering", () => {
  it("answers with an id that carries the client, read back without storing it", async () => {
    const clientId = registered(["https://grok.example/callback"]);
    expect(await resolveClient(clientId)).toEqual({
      id: clientId,
      name: "Grok",
      redirectUris: ["https://grok.example/callback"],
    });
  });

  it("names a client without a name after where it sends the user back", () => {
    const answer = registerClient({ redirect_uris: ["https://chat.example/cb"] });
    expect("client_name" in answer && answer.client_name).toBe("chat.example");
  });

  it("refuses a registration without good redirect URIs", () => {
    expect(registerClient({ client_name: "X" })).toMatchObject({ error: "invalid_client_metadata" });
    expect(registerClient({ redirect_uris: ["http://evil.example/cb"] })).toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("doesn't take a tampered id", async () => {
    const clientId = registered(["https://grok.example/callback"]);
    expect(await resolveClient(`${clientId.slice(0, -3)}AAA`)).toBeUndefined();
    expect(await resolveClient("cer-client.bm90IGpzb24")).toBeUndefined();
  });
});

describe("client metadata documents", () => {
  const url = "https://assistant.example/oauth/client.json";
  const serving =
    (body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

  it("reads a client from the document its id is the address of", async () => {
    const client = await resolveClient(
      url,
      serving({ client_id: url, client_name: "Assistant", redirect_uris: ["https://assistant.example/cb"] }),
    );
    expect(client).toEqual({ id: url, name: "Assistant", redirectUris: ["https://assistant.example/cb"] });
  });

  it("refuses a document that names another client", async () => {
    const other = serving({
      client_id: "https://elsewhere.example/c.json",
      redirect_uris: ["https://assistant.example/cb"],
    });
    expect(await resolveClient(url, other)).toBeUndefined();
  });
});

describe("tokens", () => {
  const token = { accountId: "user_123" as AccountId, grantId: "grant_1", secret: "s3cr3t-_" };

  it("read back as the kind they were made", () => {
    expect(parseToken("access", formatToken("access", token))).toEqual(token);
    expect(parseToken("refresh", formatToken("access", token))).toBeUndefined();
    expect(parseToken("code", "cerc1.a.b")).toBeUndefined();
    expect(parseToken("access", "cera1.a.b.c.d")).toBeUndefined();
    expect(parseToken("access", undefined)).toBeUndefined();
  });
});

describe("PKCE", () => {
  it("verifies the verifier its S256 challenge was made from", async () => {
    const challenge = await challengeOf(VERIFIER);
    expect(await verifiesChallenge(VERIFIER, challenge)).toBe(true);
    expect(await verifiesChallenge(`${VERIFIER}x`, challenge)).toBe(false);
    expect(await verifiesChallenge("short", await challengeOf("short"))).toBe(false);
  });
});

describe("authorizing", () => {
  it("reads a good request", async () => {
    const clientId = registered(["https://grok.example/callback"]);
    const outcome = await readAuthorize(await authorizeQuery(clientId), ISSUER);
    expect("ok" in outcome && outcome.ok).toMatchObject({
      redirectUri: "https://grok.example/callback",
      state: "xyz",
      client: { name: "Grok" },
    });
  });

  it("sends nobody to a redirect URI the client didn't register", async () => {
    const clientId = registered(["https://grok.example/callback"]);
    const outcome = await readAuthorize(
      await authorizeQuery(clientId, { redirect_uri: "https://evil.example/steal" }),
      ISSUER,
    );
    expect(outcome).toHaveProperty("refused");
  });

  it("refuses an unknown client without redirecting", async () => {
    const outcome = await readAuthorize(await authorizeQuery("who-knows"), ISSUER);
    expect(outcome).toHaveProperty("refused");
  });

  it("sends the user back with an error when PKCE is missing", async () => {
    const clientId = registered(["https://grok.example/callback"]);
    const outcome = await readAuthorize(
      await authorizeQuery(clientId, { code_challenge_method: "plain" }),
      ISSUER,
    );
    expect("redirect" in outcome).toBe(true);
    if (!("redirect" in outcome)) return;
    const back = new URL(outcome.redirect);
    expect(back.origin + back.pathname).toBe("https://grok.example/callback");
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
  });

  it("takes the only redirect URI a client registered when the request leaves it out", async () => {
    const clientId = registered(["https://grok.example/callback"]);
    const query = await authorizeQuery(clientId);
    query.delete("redirect_uri");
    const outcome = await readAuthorize(query, ISSUER);
    expect("ok" in outcome && outcome.ok.redirectUri).toBe("https://grok.example/callback");
  });
});
