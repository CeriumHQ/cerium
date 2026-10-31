import { HarnessFailure } from "@cerium/harness";
import type { AccessMode } from "@cerium/protocol";
import { Effect } from "effect";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";

import { describeTool, normalizedArgs, toolClass } from "./tools.ts";

// The other end of Cerium's PreToolUse hook: a loopback HTTP server of the session's own, which the hook
// script reaches with the session's token. Each call is answered by the access mode where it can be,
// else by the user through Cerium's approvals. Antigravity's hook answers (documented): `auto_approve`
// lets a call through where its own policy would ask, still honouring the user's explicit rules;
// `deny` refuses it with a reason the agent reads.

/** What the hook receives on stdin (camelCase, documented), as far as Cerium reads it. */
export interface HookInput {
  readonly conversationId?: string;
  readonly toolCall?: { readonly name?: string; readonly args?: unknown };
  readonly stepIdx?: number;
  readonly workspacePaths?: ReadonlyArray<string>;
}

export type HookAnswer =
  | { readonly decision: "auto_approve" }
  | { readonly decision: "deny"; readonly reason: string };

export type Verdict = "allow" | "deny" | "ask";

const WITHHELD_REASON =
  "Cerium runs subagents and questions itself: use the cerium tools (spawn agents, ask_user) instead.";

/**
 * The access mode's answer to a call, before the user's:
 * - withheld tools (native subagents, `ask_question`) are always denied;
 * - trusted servers (Cerium's bus) and reads always go through;
 * - `readOnly` denies everything else; `fullAccess` allows it; `acceptEdits` allows edits inside the
 *   workspace; anything else asks (Antigravity's own auto mode isn't Cerium's reviewer, so `auto` asks).
 */
export const verdictFor = (
  access: AccessMode,
  tool: { readonly native: string; readonly toolName: string; readonly path?: string | undefined },
  context: { readonly trusted: ReadonlyArray<string>; readonly cwd: string },
): { readonly verdict: Verdict; readonly reason?: string } => {
  const kind = toolClass(tool.native);
  if (kind === "withheld") return { verdict: "deny", reason: WITHHELD_REASON };
  if (context.trusted.some((server) => tool.toolName.startsWith(`mcp__${server}__`)))
    return { verdict: "allow" };
  if (kind === "read") return { verdict: "allow" };
  if (access === "readOnly")
    return { verdict: "deny", reason: "This agent can only read: its access is read-only." };
  if (access === "fullAccess") return { verdict: "allow" };
  if (
    access === "acceptEdits" &&
    kind === "edit" &&
    tool.path !== undefined &&
    inside(context.cwd, tool.path)
  ) {
    return { verdict: "allow" };
  }
  return { verdict: "ask" };
};

const inside = (root: string, path: string) => {
  const within = relative(root, resolve(root, path));
  return within === "" || (!within.startsWith("..") && !isAbsolute(within));
};

/** A hook call as Cerium describes it: the tool's native and Cerium names, and its normalized input. */
export const hookTool = (input: HookInput, servers: ReadonlyArray<string>, plugin: string) => {
  const native = input.toolCall?.name ?? "tool";
  const described = describeTool(native, input.toolCall?.args, servers, plugin);
  const args = normalizedArgs(input.toolCall?.args);
  const path = typeof args["path"] === "string" ? args["path"] : undefined;
  return { native, ...described, path };
};

/** What a session-wide allow covers: the same command, the same edited file, or the same tool. */
export const grantKey = (tool: ReturnType<typeof hookTool>) => {
  const command = tool.input["command"];
  if (tool.toolName === "shell" && typeof command === "string") return `shell:${command}`;
  if (toolClass(tool.native) === "edit") return `edit:${tool.path ?? tool.native}`;
  return `tool:${tool.toolName}`;
};

export interface Bridge {
  readonly port: number;
  readonly token: string;
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((done, failed) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    request.on("error", failed);
  });

/**
 * Serves the hook on a free loopback port until the scope closes. `decide` answers each call; it may
 * wait on the user for as long as the hook's own timeout lets it.
 */
export const openBridge = (decide: (input: HookInput) => Promise<HookAnswer>) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<{ readonly bridge: Bridge; readonly close: () => void }>((done, failed) => {
          const token = randomBytes(24).toString("base64url");
          const server = createServer((request, response) => {
            const answer = (status: number, body?: HookAnswer) =>
              response
                .writeHead(status, { "content-type": "application/json" })
                .end(body === undefined ? "" : JSON.stringify(body));
            if (
              request.method !== "POST" ||
              request.url !== "/hook" ||
              request.headers["x-cerium-token"] !== token
            ) {
              return void answer(403);
            }
            void readBody(request)
              .then((text) => decide(JSON.parse(text) as HookInput))
              .then(
                (decision) => answer(200, decision),
                () => answer(200, { decision: "deny", reason: "Cerium couldn't decide on this call." }),
              );
          });
          server.on("error", failed);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") return failed(new Error("no port"));
            done({ bridge: { port: address.port, token }, close: () => void server.close() });
          });
        }),
      catch: (cause) =>
        new HarnessFailure({
          provider: "antigravity",
          message: "Couldn't open Cerium's approval bridge",
          cause,
        }),
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ bridge }) => bridge));
