import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo, SkillInfo } from "@cerium/protocol";
import { Effect } from "effect";

import { ceriumEfforts, fromCodexEffort } from "./config.ts";
import type { Model } from "./protocol/v2/Model.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import { connect, type AppServer } from "./rpc.ts";

/** Every page of `model/list`. Hidden models are the ones Codex keeps out of its own picker. */
export const listAllModels = Effect.fn("CodexAdapter.listAllModels")(function* (
  server: AppServer,
  includeHidden: boolean,
) {
  const models: Array<Model> = [];
  let cursor: string | null = null;
  do {
    const page: ModelListResponse = yield* server.request("model/list", { cursor, includeHidden });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return models;
});

export const toModelInfo = (model: Model): ModelInfo => {
  const defaultEffort = fromCodexEffort(model.defaultReasoningEffort);
  return {
    provider: "codex",
    // `thread/start` takes the model slug.
    id: model.model,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    efforts: ceriumEfforts(model.supportedReasoningEfforts.map((option) => option.reasoningEffort)),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(CACHE_SAFE_EFFORT.has(model.model) ? { cacheSafeEffort: true } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
  };
};

/**
 * The models whose prompt cache survived an effort switch in a live check (0.164.0, medium → low,
 * with `reasoning_effort_override` on): Codex sends it as a `configuration_update`. GPT-5.6 models
 * start the cache over.
 */
const CACHE_SAFE_EFFORT: ReadonlySet<string> = new Set(["gpt-6-luna"]);

/** Asks the user's `codex` which models its picker offers. No thread is started. */
export const listCodexModels = Effect.fn("CodexAdapter.listModels")(function* (executablePath: string) {
  const server = yield* connect(executablePath);
  const models = yield* listAllModels(server, false).pipe(
    Effect.mapError(
      (cause) => new HarnessFailure({ provider: "codex", message: "Could not list Codex models", cause }),
    ),
  );
  return models.map(toModelInfo);
}, Effect.scoped);

/** The enabled skills Codex finds for `cwd`. No thread is started. */
export const listCodexSkills = Effect.fn("CodexAdapter.listSkills")(function* (
  executablePath: string,
  cwd: string,
) {
  const server = yield* connect(executablePath);
  const { data } = yield* server
    .request("skills/list", { cwds: [cwd] })
    .pipe(
      Effect.mapError(
        (cause) => new HarnessFailure({ provider: "codex", message: "Could not list Codex skills", cause }),
      ),
    );
  return data.flatMap((entry) =>
    entry.skills
      .filter((skill) => skill.enabled)
      .map((skill): SkillInfo => ({
        name: skill.name,
        description: skill.shortDescription ?? skill.description,
        path: skill.path,
      })),
  );
}, Effect.scoped);
