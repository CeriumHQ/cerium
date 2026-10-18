import type { AgentId } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { HttpServerRequest } from "effect/http";

import type { BusRegistry } from "./registry.ts";

// Bus tools that answer with more than JSON. A toolkit tool's result is always one JSON text block,
// so tools that show the agent an image register on the MCP server directly.

/** What a raw tool answers: text (JSON when not a string) and optionally a PNG. */
export interface RawReply {
  readonly text: unknown;
  readonly image?: Uint8Array;
  readonly isError?: boolean;
}

const BEARER = /^Bearer\s+(.+)$/i;

/** The agent making this call, from its per-session bearer token. */
export const callerOf = (registry: BusRegistry["Service"]) =>
  Effect.gen(function* () {
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
    const token = Option.flatMap(request, (http) =>
      Option.fromNullishOr(BEARER.exec(http.headers["authorization"] ?? "")?.[1]),
    );
    return Option.flatMap(token, (value) => registry.agentFor(value));
  });

const toResult = (reply: RawReply) =>
  new McpSchema.CallToolResult({
    ...(reply.isError ? { isError: true } : {}),
    content: [
      { type: "text", text: typeof reply.text === "string" ? reply.text : JSON.stringify(reply.text) },
      ...(reply.image === undefined
        ? []
        : [{ type: "image" as const, data: reply.image, mimeType: "image/png" }]),
    ],
  });

export const failure = (text: string): RawReply => ({ text, isError: true });

/**
 * Registers one tool whose handler gets the calling agent and its decoded input. Input that does not
 * decode, and calls from outside a Cerium session, answer with an error the agent can read.
 */
export const registerRawTool = <S extends Schema.Top & { readonly DecodingServices: never }>(options: {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
  readonly registry: BusRegistry["Service"];
  readonly readOnly?: boolean;
  readonly handle: (caller: AgentId, input: S["Type"]) => Effect.Effect<RawReply>;
}) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const definition = Tool.make(options.name, {
      description: options.description,
      parameters: options.parameters,
    });
    const decode = Schema.decodeUnknownEffect(options.parameters);
    // An empty struct has no object schema of its own, and MCP wants one.
    const json = Tool.getJsonSchema(definition);
    const inputSchema = (
      json["type"] === "object" ? json : { type: "object", properties: {} }
    ) as McpSchema.ToolJson;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: options.name,
        description: options.description,
        inputSchema,
        annotations: { readOnlyHint: options.readOnly ?? false, openWorldHint: true },
      }),
      annotations: definition.annotations,
      handle: (payload) =>
        Effect.gen(function* () {
          const caller = yield* callerOf(options.registry);
          if (Option.isNone(caller)) return failure("Unknown Cerium agent.");
          const input = yield* decode(payload ?? {}).pipe(Effect.result);
          if (input._tag === "Failure") return failure(`Invalid input: ${input.failure.message}`);
          return yield* options.handle(caller.value, input.success);
        }).pipe(Effect.map(toResult)),
    });
  });
