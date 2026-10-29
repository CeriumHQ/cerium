import { AssistantName, type AccountId } from "@cerium/protocol";
import { Option, Schema } from "effect";

// Signing assistants in. An assistant reaches the relay's MCP endpoint with an OAuth 2.1 access
// token, as MCP's authorization spec has it: it finds the relay's metadata, registers itself (or
// names a client metadata document), sends the user to `/oauth/authorize` with a PKCE challenge,
// and redeems the code the user's approval hands it at `/oauth/token`. The user approves on the
// relay's own page, signed in with Clerk; the grant lives in their account's object, which keeps
// only hashes of its code and tokens. Every token names its account and grant, so the Worker knows
// which object to ask.

/** How long an access token lasts; the assistant refreshes it with its refresh token. */
export const ACCESS_TTL_S = 60 * 60;

/** How long the code an approval hands the assistant may be redeemed. */
export const CODE_TTL_MS = 5 * 60 * 1000;

/** What a grant lets an assistant do; the only scope there is. */
export const SCOPE = "threads";

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
} as const;

/** RFC 9728: where the MCP endpoint's sign-in is, which a 401 from it points at. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** RFC 8414: the authorization server's endpoints. */
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

export const protectedResource = (origin: string, mcpPath: string) => ({
  resource: `${origin}${mcpPath}`,
  authorization_servers: [origin],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ["header"],
  resource_name: "Cerium",
});

export const authorizationServer = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
  token_endpoint: `${origin}${OAUTH_PATHS.token}`,
  registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
  scopes_supported: [SCOPE],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
});

// ---- Tokens ---------------------------------------------------------------------------------

/** A code or token: `<kind>.<account>.<grant>.<secret>`, every part base64url-safe. */
export interface GrantToken {
  readonly accountId: AccountId;
  readonly grantId: string;
  readonly secret: string;
}

export type TokenKind = "code" | "access" | "refresh";

const PREFIXES: Record<TokenKind, string> = { code: "cerc1", access: "cera1", refresh: "cerr1" };

const PART = /^[A-Za-z0-9_-]+$/;

export const formatToken = (kind: TokenKind, { accountId, grantId, secret }: GrantToken): string =>
  `${PREFIXES[kind]}.${accountId}.${grantId}.${secret}`;

export const parseToken = (kind: TokenKind, text: string | undefined): GrantToken | undefined => {
  const [prefix, accountId, grantId, secret, ...rest] = (text ?? "").split(".");
  if (prefix !== PREFIXES[kind] || rest.length > 0) return undefined;
  if (accountId === undefined || grantId === undefined || secret === undefined) return undefined;
  if (![accountId, grantId, secret].every((part) => PART.test(part))) return undefined;
  return { accountId: accountId as AccountId, grantId, secret };
};

/** An OAuth error, as the token endpoint answers it (RFC 6749 §5.2). */
export interface OAuthError {
  readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type";
  readonly error_description: string;
}

export const oauthError = (error: OAuthError["error"], description: string): OAuthError => ({
  error,
  error_description: description,
});

/** The token endpoint's answer. */
export interface Tokens {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

// ---- PKCE -----------------------------------------------------------------------------------

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** An S256 challenge: base64url of a SHA-256, 43 characters. */
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Whether `verifier` is the one the S256 `challenge` was made from. */
export const verifiesChallenge = async (verifier: string, challenge: string): Promise<boolean> => {
  if (!VERIFIER.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest)) === challenge;
};

// ---- Clients --------------------------------------------------------------------------------

/** An assistant's OAuth client: what it is called and where approvals may send the user back. */
export interface Client {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
}

const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI = 512;

/** Schemes a page must never be sent to, whatever a client registered. */
const UNSAFE_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a client may register `uri` to be sent back to: `https:`, `http:` on the loopback address
 * only (a desktop app listening there), or an app's own scheme (`cursor://…`), never with a fragment.
 */
export const isRedirectUri = (uri: string): boolean => {
  if (uri.length > MAX_REDIRECT_URI) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "" || uri.includes("#")) return false;
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_SCHEMES.has(url.protocol);
};

/**
 * Whether `uri` is one of the client's: exactly, or for a loopback one on any port, which a native
 * app picks when it starts (RFC 8252 §7.3).
 */
export const allowsRedirect = (client: Client, uri: string): boolean =>
  client.redirectUris.some((registered) => {
    if (registered === uri) return true;
    try {
      const a = new URL(registered);
      const b = new URL(uri);
      return (
        a.protocol === "http:" &&
        LOOPBACK.has(a.hostname) &&
        a.protocol === b.protocol &&
        a.hostname === b.hostname &&
        a.pathname === b.pathname &&
        a.search === b.search
      );
    } catch {
      return false;
    }
  });

/** Where an approval sends the user, as the approval page shows it: the host, or the app's scheme. */
export const siteOf = (uri: string): string => {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol.slice(0, -1);
  } catch {
    return uri;
  }
};

const decodeName = Schema.decodeUnknownOption(AssistantName);

/** What a client registers as, or the site it sends the user back to when it gives no name. */
const nameOf = (name: unknown, redirectUris: ReadonlyArray<string>): string =>
  Option.getOrElse(decodeName(typeof name === "string" ? name.slice(0, 64) : undefined), () =>
    siteOf(redirectUris[0] ?? "Assistant"),
  );

/**
 * Registered clients are kept nowhere: the id a registration answers with carries what was
 * registered. Anyone may register any client, so this costs nothing: what keeps a client out is the
 * user, who sees its name and site before allowing it.
 */
const REGISTERED = "cer-client.";

const encodeClient = (name: string, redirectUris: ReadonlyArray<string>) =>
  `${REGISTERED}${base64url(new TextEncoder().encode(JSON.stringify({ n: name, r: redirectUris })))}`;

const decodeClient = (clientId: string): Client | undefined => {
  if (!clientId.startsWith(REGISTERED)) return undefined;
  try {
    const json = atob(clientId.slice(REGISTERED.length).replaceAll("-", "+").replaceAll("_", "/"));
    const { n, r } = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    if (typeof n !== "string" || !Array.isArray(r) || r.length === 0 || r.length > MAX_REDIRECT_URIS)
      return undefined;
    if (!r.every((uri): uri is string => typeof uri === "string" && isRedirectUri(uri))) return undefined;
    const name = Option.getOrUndefined(decodeName(n));
    return name === undefined ? undefined : { id: clientId, name, redirectUris: r };
  } catch {
    return undefined;
  }
};

/** A client's metadata, as a registration (RFC 7591) or a client metadata document gives it. */
const readMetadata = (body: unknown): { name: string; redirectUris: ReadonlyArray<string> } | string => {
  if (typeof body !== "object" || body === null) return "The registration isn't a JSON object.";
  const { client_name: name, redirect_uris: uris } = body as Record<string, unknown>;
  if (!Array.isArray(uris) || uris.length === 0) return "A client needs at least one redirect_uri.";
  if (uris.length > MAX_REDIRECT_URIS)
    return `A client may register up to ${MAX_REDIRECT_URIS} redirect URIs.`;
  if (!uris.every((uri): uri is string => typeof uri === "string" && isRedirectUri(uri)))
    return "Redirect URIs are https:, http: on localhost, or an app's own scheme, without a fragment.";
  return { name: nameOf(name, uris), redirectUris: uris };
};

/** `POST /oauth/register`: the client's id and what it was registered with, or why it wasn't. */
export const registerClient = (body: unknown) => {
  const metadata = readMetadata(body);
  if (typeof metadata === "string") return { error: "invalid_client_metadata", error_description: metadata };
  return {
    client_id: encodeClient(metadata.name, metadata.redirectUris),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: metadata.name,
    redirect_uris: metadata.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
};

/** A client metadata document is a small JSON file; anything bigger isn't one. */
const MAX_METADATA_BYTES = 16 * 1024;

/**
 * The client `clientId` names: a registered one, or one whose id is the `https:` URL of its client
 * metadata document, which is fetched and must name itself by that URL.
 */
export const resolveClient = async (
  clientId: string,
  fetcher: typeof fetch = fetch,
): Promise<Client | undefined> => {
  const registered = decodeClient(clientId);
  if (registered !== undefined) return registered;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash !== "") return undefined;
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) return undefined;
    const body: unknown = JSON.parse(text);
    if ((body as { client_id?: unknown }).client_id !== clientId) return undefined;
    const metadata = readMetadata(body);
    return typeof metadata === "string" ? undefined : { id: clientId, ...metadata };
  } catch {
    return undefined;
  }
};

// ---- Authorizing ----------------------------------------------------------------------------

/** What `/oauth/authorize` is asked, once its client and redirect URI are known to be good. */
export interface AuthorizeRequest {
  readonly client: Client;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state?: string;
}

export type AuthorizeOutcome =
  | { readonly ok: AuthorizeRequest }
  /** The client or its redirect URI isn't good: the user is told, and sent nowhere. */
  | { readonly refused: string }
  /** Anything else: the user goes back to the client with the error, as OAuth has it. */
  | { readonly redirect: string };

/** Sends the user back to the client with `params`, and the issuer (RFC 9207). */
export const redirectTo = (
  redirectUri: string,
  params: Record<string, string | undefined>,
  issuer: string,
) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...params, iss: issuer }))
    if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
};

/** Reads an authorization request: the approval page's query, or what it posts back. */
export const readAuthorize = async (
  params: URLSearchParams,
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthorizeOutcome> => {
  const clientId = params.get("client_id");
  if (clientId === null || clientId === "") return { refused: "The app didn't say who it is." };
  const client = await resolveClient(clientId, fetcher);
  if (client === undefined)
    return { refused: "Cerium doesn't recognise this app. Connect Cerium again from the app." };
  const redirectUri =
    params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (redirectUri === undefined || !allowsRedirect(client, redirectUri))
    return { refused: "This app asked to be sent somewhere it didn't register." };
  const state = params.get("state") ?? undefined;
  const fail = (error: string, description: string) => ({
    redirect: redirectTo(redirectUri, { error, error_description: description, state }, issuer),
  });
  if (params.get("response_type") !== "code")
    return fail("unsupported_response_type", "Only `code` is supported.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !CHALLENGE.test(codeChallenge))
    return fail("invalid_request", "PKCE with S256 is required.");
  return { ok: { client, redirectUri, codeChallenge, ...(state === undefined ? {} : { state }) } };
};
