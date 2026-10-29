import { ASSISTANT_MCP_PATH, type AccountId } from "@cerium/protocol";

import type { Account } from "./account.ts";
import { clerkUser } from "./clerk.ts";
import type { Env } from "./env.ts";
import { bearer, json, refuse } from "./http.ts";
import { tooMany, PERIODS } from "./limits.ts";
import { parseError } from "./mcp.ts";
import {
  AUTHORIZATION_SERVER_PATH,
  authorizationServer,
  formatToken,
  OAUTH_PATHS,
  oauthError,
  parseToken,
  PROTECTED_RESOURCE_PATH,
  protectedResource,
  readAuthorize,
  redirectTo,
  registerClient,
  siteOf,
} from "./oauth.ts";

// The routes assistants reach the relay by: the MCP endpoint, OAuth's endpoints and metadata, and
// what the approval page and Settings ask. Each answers here, or asks the account's object.

const accountStub = (env: Env, accountId: AccountId): DurableObjectStub<Account> =>
  env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId));

/** Assistants may run in a browser, so what they call answers any origin. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

const withCors = (response: Response): Response => {
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  return response;
};

/** The approval page may not be framed: a frame could trick the user into allowing an assistant. */
const PAGE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** A request's form body (OAuth's), or its JSON one from a client that sends that instead. */
const readParams = async (request: Request): Promise<URLSearchParams> => {
  const type = request.headers.get("Content-Type") ?? "";
  if (type.includes("application/json")) {
    const body: unknown = await request.json().catch(() => ({}));
    const params = new URLSearchParams();
    if (typeof body === "object" && body !== null)
      for (const [key, value] of Object.entries(body)) if (typeof value === "string") params.set(key, value);
    return params;
  }
  return new URLSearchParams(await request.text().catch(() => ""));
};

const tokenAnswer = (body: unknown, status = 200) => {
  const response = json(body, status);
  response.headers.set("Pragma", "no-cache");
  return withCors(response);
};

const limited = async (limiter: RateLimit, key: string, period: number) =>
  (await limiter.limit({ key })).success ? undefined : withCors(tooMany(period));

/** `POST /oauth/token`: a code or a refresh token, for new tokens. */
const token = async (request: Request, env: Env): Promise<Response> => {
  const params = await readParams(request);
  const grantType = params.get("grant_type");
  const clientId = params.get("client_id") ?? undefined;
  if (grantType === "authorization_code") {
    const code = parseToken("code", params.get("code") ?? undefined);
    const verifier = params.get("code_verifier");
    if (code === undefined)
      return tokenAnswer(oauthError("invalid_grant", "That isn't a code Cerium issued."), 400);
    if (clientId === undefined || verifier === null)
      return tokenAnswer(oauthError("invalid_request", "client_id and code_verifier are required."), 400);
    const outcome = await accountStub(env, code.accountId).redeemAssistant(
      code,
      clientId,
      params.get("redirect_uri") ?? undefined,
      verifier,
    );
    return tokenAnswer(outcome, "error" in outcome ? 400 : 200);
  }
  if (grantType === "refresh_token") {
    const refresh = parseToken("refresh", params.get("refresh_token") ?? undefined);
    if (refresh === undefined)
      return tokenAnswer(oauthError("invalid_grant", "That isn't a refresh token Cerium issued."), 400);
    const outcome = await accountStub(env, refresh.accountId).refreshAssistant(refresh, clientId);
    return tokenAnswer(outcome, "error" in outcome ? 400 : 200);
  }
  return tokenAnswer(oauthError("unsupported_grant_type", "Use authorization_code or refresh_token."), 400);
};

/** `POST /mcp`: a JSON-RPC message from a connected assistant. */
const mcp = async (request: Request, env: Env): Promise<Response> => {
  const metadata = `${env.PUBLIC_ORIGIN}${PROTECTED_RESOURCE_PATH}`;
  const unauthorized = (error?: string) => {
    const response = refuse(401, "Connect this app to your Cerium account.");
    response.headers.set(
      "WWW-Authenticate",
      `Bearer ${error === undefined ? "" : `error="${error}", `}resource_metadata="${metadata}"`,
    );
    return withCors(response);
  };
  const presented = bearer(request);
  if (presented === undefined) return unauthorized();
  const access = parseToken("access", presented);
  if (access === undefined) return unauthorized("invalid_token");
  const over = await limited(
    env.ASSISTANT_LIMIT,
    `${access.accountId}/${access.grantId}`,
    PERIODS.ASSISTANT_LIMIT,
  );
  if (over !== undefined) return over;
  if (request.method !== "POST") {
    // Nothing is ever sent unasked, so there's no stream to open.
    const response = refuse(405, "Send JSON-RPC messages with POST.");
    response.headers.set("Allow", "POST");
    return withCors(response);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(json(parseError, 400));
  }
  const outcome = await accountStub(env, access.accountId).assistantMcp(access, body);
  if (outcome === "unauthorized") return unauthorized("invalid_token");
  if (outcome.answer === undefined) return withCors(new Response(null, { status: 202 }));
  return withCors(
    new Response(outcome.answer, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
};

/** `GET /oauth/authorize`: the approval page, or straight back to the assistant with an error. */
const authorize = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const outcome = await readAuthorize(url.searchParams, env.PUBLIC_ORIGIN);
  if ("redirect" in outcome) return Response.redirect(outcome.redirect, 302);
  // The page reads the request from its own address and asks what it's about.
  const page = await env.ASSETS.fetch(new Request(new URL("/assistant", url), { headers: request.headers }));
  const response = new Response(page.body, page);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) response.headers.set(name, value);
  return response;
};

/**
 * The approval page's questions: `GET /api/oauth/client?<the request>` says which assistant asks;
 * `POST /api/oauth/approve` with the user's session token allows it, and answers with where to send
 * them, carrying the code.
 */
export const assistantApproval = async (
  request: Request,
  env: Env,
  action: string | undefined,
): Promise<Response> => {
  const url = new URL(request.url);
  if (action === "client" && request.method === "GET") {
    const outcome = await readAuthorize(url.searchParams, env.PUBLIC_ORIGIN);
    if ("refused" in outcome) return refuse(400, outcome.refused);
    if ("redirect" in outcome) return json({ next: outcome.redirect });
    const { client, redirectUri, state } = outcome.ok;
    return json({
      name: client.name,
      site: siteOf(redirectUri),
      deny: redirectTo(
        redirectUri,
        { error: "access_denied", error_description: "The user didn't allow it.", state },
        env.PUBLIC_ORIGIN,
      ),
    });
  }
  if (action === "approve" && request.method === "POST") {
    const accountId = await clerkUser(request, env);
    if (accountId === undefined) return refuse(401, "Sign in to allow this app.");
    const body: unknown = await request.json().catch(() => undefined);
    const query = (body as { request?: unknown } | undefined)?.request;
    if (typeof query !== "string") return refuse(400, "That approval isn't one the relay understands.");
    const outcome = await readAuthorize(new URLSearchParams(query), env.PUBLIC_ORIGIN);
    if ("refused" in outcome) return refuse(400, outcome.refused);
    if ("redirect" in outcome) return json({ next: outcome.redirect });
    const { client, redirectUri, codeChallenge, state } = outcome.ok;
    const code = await accountStub(env, accountId).approveAssistant(
      accountId,
      { id: client.id, name: client.name },
      redirectUri,
      codeChallenge,
    );
    return json({
      next: redirectTo(redirectUri, { code: formatToken("code", code), state }, env.PUBLIC_ORIGIN),
    });
  }
  return refuse(405, "Not allowed.");
};

/**
 * The assistants' routes outside `/api`, or none for a path that isn't one of them: the MCP endpoint,
 * OAuth's endpoints, and the metadata that points at them.
 */
export const assistantRoute = async (request: Request, env: Env): Promise<Response | undefined> => {
  const { pathname } = new URL(request.url);
  const ours =
    pathname === ASSISTANT_MCP_PATH ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith(PROTECTED_RESOURCE_PATH) ||
    pathname.startsWith(AUTHORIZATION_SERVER_PATH);
  if (!ours) return undefined;
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  if (pathname === ASSISTANT_MCP_PATH) return mcp(request, env);

  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const over = await limited(env.PUBLIC_LIMIT, address, PERIODS.PUBLIC_LIMIT);
  if (over !== undefined) return over;
  if (pathname.startsWith(PROTECTED_RESOURCE_PATH) && request.method === "GET")
    return withCors(json(protectedResource(env.PUBLIC_ORIGIN, ASSISTANT_MCP_PATH)));
  if (pathname.startsWith(AUTHORIZATION_SERVER_PATH) && request.method === "GET")
    return withCors(json(authorizationServer(env.PUBLIC_ORIGIN)));
  if (pathname === OAUTH_PATHS.authorize && request.method === "GET") return authorize(request, env);
  if (pathname === OAUTH_PATHS.token && request.method === "POST") return token(request, env);
  if (pathname === OAUTH_PATHS.register && request.method === "POST") {
    const body: unknown = await request.json().catch(() => undefined);
    const registered = registerClient(body);
    return withCors(json(registered, "error" in registered ? 400 : 201));
  }
  return withCors(refuse(404, "Not found."));
};
