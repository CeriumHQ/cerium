import {
  ClaimLinkRequest,
  ConfirmLinkRequest,
  CreateLinkRequest,
  credentialFromProtocols,
  DeviceId,
  LinkId,
  parseCredential,
  randomToken,
  RenameDeviceRequest,
  ThreadId,
  type ConfirmLinkResponse,
  type CreateLinkResponse,
  type Credential,
} from "@cerium/protocol";

import type { Outcome } from "./account.ts";
import { assistantApproval, assistantRoute } from "./assistants.ts";
import { clerkUser } from "./clerk.ts";
import { vapidKeys, type Env } from "./env.ts";
import { bearer, json, param, readBody, refuse, refusedSocket } from "./http.ts";
import { limit } from "./limits.ts";

export { Account } from "./account.ts";
export { Link } from "./link.ts";

// Cerium's relay. Static files (the sign-in page) are served from
// public/; everything under /api comes here, and assistants' MCP and OAuth routes (assistants.ts). Each account is one `Account` object and each pending
// sign-in one `Link` object; this Worker only checks requests and routes them.

const answer = (outcome: Outcome): Response =>
  outcome.ok ? new Response(null, { status: 204 }) : refuse(outcome.status, outcome.message);

const linkStub = (env: Env, id: LinkId) => env.LINKS.get(env.LINKS.idFromName(id));

const accountStub = (env: Env, credential: Credential) =>
  env.ACCOUNTS.get(env.ACCOUNTS.idFromName(credential.accountId));

const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const [api, resource, id, action] = parts;
  if (api !== "api" || parts.length > 4) return refuse(404, "Not found.");
  const refused = await limit(env, request, resource, id);
  if (refused !== undefined) return refused;
  const method = request.method;

  if (resource === "config" && method === "GET" && id === undefined) {
    const vapid = vapidKeys(env);
    return json({
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
      ...(vapid === undefined ? {} : { vapidPublicKey: vapid.publicKey }),
    });
  }

  // A machine starts signing in.
  if (resource === "links" && id === undefined && method === "POST") {
    const body = await readBody(request, CreateLinkRequest);
    if (body === undefined) return refuse(400, "That sign-in request isn't one the relay understands.");
    const linkId = randomToken(32) as LinkId;
    const created = await linkStub(env, linkId).create(body);
    if (!created.ok) return refuse(created.status, created.message);
    return json(
      {
        id: linkId,
        url: `${env.PUBLIC_ORIGIN}/link#${linkId}`,
        expiresAt: created.expiresAt,
      } satisfies CreateLinkResponse,
      201,
    );
  }

  if (resource === "links" && id !== undefined) {
    const linkId = param(id, LinkId);
    if (linkId === undefined) return refuse(404, "This sign-in link doesn't exist.");
    const link = linkStub(env, linkId);

    if (action === undefined && method === "GET") {
      const view = await link.view();
      return view === undefined
        ? refuse(404, "This sign-in link has expired. Start again from Cerium.")
        : json(view);
    }
    if (action === "confirm" && method === "POST") {
      const accountId = await clerkUser(request, env);
      if (accountId === undefined) return refuse(401, "Sign in to connect this machine.");
      const body = await readBody(request, ConfirmLinkRequest);
      if (body === undefined) return refuse(400, "That confirmation isn't one the relay understands.");
      const outcome = await link.confirm(linkId, accountId, body.profile);
      return outcome.ok
        ? json({ next: outcome.next } satisfies ConfirmLinkResponse)
        : refuse(outcome.status, outcome.message);
    }
    if (action === "claim" && method === "POST") {
      const secret = bearer(request);
      if (secret === undefined) return refuse(401, "The machine's secret is missing.");
      // Without a code it only asks whether the machine joined already.
      const body = (await readBody(request, ClaimLinkRequest)) ?? {};
      const outcome = await link.claim(secret, body.code);
      if (outcome === "expired") return refuse(410, "The sign-in link expired before it was confirmed.");
      if (outcome === "forbidden") return refuse(403, "That isn't the machine that started this sign-in.");
      return json(outcome);
    }
    return refuse(405, "Not allowed.");
  }

  // A signed-in device's live connection.
  if (resource === "connect" && id === undefined) {
    if (request.headers.get("Upgrade") !== "websocket") return refuse(426, "Connect with a WebSocket.");
    const credential = credentialFromProtocols(request.headers.get("Sec-WebSocket-Protocol"));
    return credential === undefined ? refusedSocket("invalid") : accountStub(env, credential).fetch(request);
  }

  // A thread of another machine, read from the cloud copy.
  if (resource === "sync" && id !== undefined && action !== undefined && method === "GET") {
    const credential = parseCredential(bearer(request) ?? "");
    if (credential === undefined) return refuse(401, "This device isn't signed in.");
    const machine = param(id, DeviceId);
    const threadId = param(action, ThreadId);
    if (machine === undefined || threadId === undefined)
      return refuse(404, "That thread isn't in your account.");
    const events = await accountStub(env, credential).threadEvents(credential, machine, threadId);
    return typeof events === "string"
      ? new Response(events, {
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        })
      : refuse(events.ok ? 500 : events.status, events.ok ? "Couldn't read that thread." : events.message);
  }

  // The approval page an assistant sends the user to.
  if (resource === "oauth" && action === undefined) return assistantApproval(request, env, id);

  // The account's connected assistants, which any of its devices lists and disconnects.
  if (resource === "assistants") {
    const credential = parseCredential(bearer(request) ?? "");
    if (credential === undefined) return refuse(401, "This device isn't signed in.");
    const account = accountStub(env, credential);
    if (id === undefined && action === undefined && method === "GET") {
      const listed = await account.listAssistants(credential);
      return "assistants" in listed ? json(listed) : answer(listed);
    }
    if (id !== undefined && action === undefined && method === "DELETE")
      return answer(await account.disconnectAssistant(credential, id));
    return refuse(405, "Not allowed.");
  }

  // Renaming and removing devices.
  if (resource === "devices" && id !== undefined) {
    const credential = parseCredential(bearer(request) ?? "");
    if (credential === undefined) return refuse(401, "This device isn't signed in.");
    const targetId = param(id, DeviceId);
    if (targetId === undefined) return refuse(404, "That device isn't part of your account.");
    const account = accountStub(env, credential);
    if (action === undefined && method === "PATCH") {
      const body = await readBody(request, RenameDeviceRequest);
      if (body === undefined) return refuse(400, "A device's name is 1 to 64 characters.");
      return answer(await account.rename(credential, targetId, body.name));
    }
    if (action === undefined && method === "DELETE")
      return answer(await account.remove(credential, targetId));
    return refuse(405, "Not allowed.");
  }

  return refuse(404, "Not found.");
};

export default {
  async fetch(request, env) {
    try {
      return (await assistantRoute(request, env)) ?? (await route(request, env));
    } catch (error) {
      console.error(error);
      return refuse(500, "Cerium's relay hit a problem. Try again in a moment.");
    }
  },
} satisfies ExportedHandler<Env>;
