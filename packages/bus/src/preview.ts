import { ReviewLedger } from "@cerium/browser";
import { createHash } from "node:crypto";
import { ARTIFACT_COLUMN_WIDTH } from "@cerium/artifacts";
import { previewArtifact } from "@cerium/artifacts/preview";
import { Orchestrator } from "@cerium/orchestrator";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServerRequest } from "effect/http";

import { BusRegistry } from "./registry.ts";

// `artifact_preview`: an agent's artifact rendered as the conversation will draw it, returned as an
// image. Registered on the server directly, since a toolkit's tools answer with JSON text only.

const NAME = "artifact_preview";

const Input = Schema.Struct({
  state: Schema.optionalKey(Schema.String),
  defect: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000_000)),
  width: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 280, maximum: 1600 }))),
  mode: Schema.optional(Schema.Literals(["dark", "light"])),
});

const tool = new McpSchema.Tool({
  name: NAME,
  title: "Preview artifact",
  description:
    "Render an artifact's HTML as the conversation will show it, in Cerium's theme, and get back a" +
    " screenshot, the height its frame takes and its console output (errors, failed loads). Use it to" +
    " check and fix a page before you put it in your reply; see `artifact_guide`.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Artifact and state being reviewed; keep stable across fixes." },
      defect: { type: "string", description: "Unresolved defect, required after two reviews." },
      fix: { type: "string", description: "Fix being verified, required after two reviews." },
      html: { type: "string", description: "The page, exactly as it will go in the artifact block." },
      width: {
        type: "integer",
        description: `Width in CSS pixels, 280-1600. Defaults to ${ARTIFACT_COLUMN_WIDTH}, the conversation's column; about 380 checks phones.`,
      },
      mode: { type: "string", enum: ["dark", "light"], description: "Light or dark mode. Defaults to dark." },
    },
    required: ["html"],
  },
  annotations: {
    title: "Preview artifact",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
});

const BEARER = /^Bearer\s+(.+)$/i;

const failure = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });

/** Registers `artifact_preview` on the bus's MCP server. Requires the BusRegistry and the Orchestrator. */
export const ArtifactPreviewTool = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registry = yield* BusRegistry;
    const reviews = new Map<string, ReviewLedger>();
    let captures = 0;
    const orchestrator = yield* Orchestrator;
    yield* server.addTool({
      tool,
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.gen(function* () {
          // Only agents Cerium started get a browser on this machine.
          const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
          const token = Option.flatMap(request, (http) =>
            Option.fromNullishOr(BEARER.exec(http.headers["authorization"] ?? "")?.[1]),
          );
          const agentId = Option.flatMap(token, (value) => registry.agentFor(value));
          if (Option.isNone(agentId)) return failure("Unknown Cerium agent.");
          // Data files are embedded only from the caller's thread's folder, as in the conversation.
          const folder = yield* orchestrator.agent(agentId.value).pipe(
            Effect.flatMap(({ threadId }) =>
              orchestrator.listThreads.pipe(
                Effect.map((threads) => threads.find((thread) => thread.id === threadId)?.cwd),
              ),
            ),
            Effect.orElseSucceed(() => undefined),
          );
          const input = yield* Schema.decodeUnknownEffect(Input)(payload).pipe(Effect.option);
          if (Option.isNone(input)) {
            return failure("Give `html` (a non-empty string), and optionally `width` (280-1600) and `mode`.");
          }
          const { html, width = ARTIFACT_COLUMN_WIDTH, mode = "dark" } = input.value;
          const ledger = reviews.get(agentId.value) ?? new ReviewLedger();
          reviews.delete(agentId.value);
          reviews.set(agentId.value, ledger);
          if (reviews.size > 256) reviews.delete(reviews.keys().next().value!);
          const key = JSON.stringify([width, mode, input.value.state ?? "artifact"]);
          const issue = ledger.check(key, input.value);
          if (issue) return new McpSchema.CallToolResult({ content: [{ type: "text", text: issue }] });
          const preview = yield* Effect.tryPromise(() => previewArtifact({ html, width, mode, folder })).pipe(
            Effect.result,
          );
          if (preview._tag === "Failure") {
            const cause = preview.failure.cause;
            return failure(`The preview failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
          const { png, contentHeight, growsWithFrame, console } = preview.success;
          const capture = ledger.record(
            key,
            createHash("sha256").update(png).digest("hex"),
            `artifact-${++captures}`,
            input.value,
          );
          const summary = [
            `Rendered at ${width}px in ${mode} mode; the frame takes ${contentHeight}px.`,
            ...(growsWithFrame
              ? [
                  "The page grew when its frame did: a height in vh units or height: 100% on html/body never settles. Let content set the height.",
                ]
              : []),
            console.length === 0
              ? "Console: nothing."
              : `Console:\n${console
                  .slice(-20)
                  .map((entry) => `[${entry.level}] ${entry.text}`)
                  .join("\n")}`,
          ].join("\n");
          return new McpSchema.CallToolResult({
            content: [
              { type: "text", text: summary },
              ...(capture.changed
                ? [{ type: "image" as const, data: png, mimeType: "image/png" }]
                : [{ type: "text" as const, text: `Unchanged; reuse ${capture.capture}. No image sent.` }]),
            ],
          });
        }),
    });
  }),
);
