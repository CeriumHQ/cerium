import { HarnessFailure, type CompletionRequest } from "@cerium/harness";
import { Effect } from "effect";

import { call, type OpenCodeClient } from "./host.ts";
import { modelId, parseModel, variantFor, type CatalogRow } from "./models.ts";

/** A model's quickest variant: reasoning off where it can be, else its lowest effort. */
export const quickestVariant = (row: CatalogRow | undefined): string | undefined => {
  if (row === undefined) return undefined;
  const variants = row.variants.map((variant) => variant.id);
  return variants.includes("none") ? "none" : variantFor("minimal", variants);
};

/** `generate.text` takes no system prompt, so the instructions open the prompt, marked as Cerium's. */
export const completionPrompt = (request: Pick<CompletionRequest, "instructions" | "prompt">) =>
  [
    "<cerium_instructions>",
    "Cerium, the app asking, adds these instructions. Follow them like system instructions.",
    "",
    request.instructions,
    "</cerium_instructions>",
    "",
    request.prompt,
  ].join("\n");

/**
 * One stateless generation: no session is stored, and no tools, MCP servers or project instructions
 * take part. Resolves with the reply's text.
 */
export const completeWithOpenCode = Effect.fn("OpenCodeAdapter.complete")(function* (
  client: OpenCodeClient,
  request: CompletionRequest,
  catalog: ReadonlyArray<CatalogRow>,
) {
  const ref = parseModel(request.model);
  if (ref === undefined) {
    return yield* new HarnessFailure({
      provider: "opencode",
      message: `"${request.model}" is not an OpenCode model; models are named provider/model`,
      cause: request.model,
    });
  }
  const variant = quickestVariant(catalog.find((row) => modelId(row) === request.model));
  const reply = yield* call("answer", (signal) =>
    client.generate.text(
      { prompt: completionPrompt(request), model: variant === undefined ? ref : { ...ref, variant } },
      { signal },
    ),
  );
  if (reply.text.trim() !== "") return reply.text;
  return yield* new HarnessFailure({
    provider: "opencode",
    message: "OpenCode's reply was empty",
    cause: reply,
  });
});
