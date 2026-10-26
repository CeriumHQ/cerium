import { HarnessFailure } from "@cerium/harness";
import type { ModelInfo, ModelSpeed, SkillInfo } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { ceriumEfforts, fromCodexEffort, fromServiceTier } from "./config.ts";
import type { Config } from "./protocol/v2/Config.ts";
import type { ConfigRequirementsReadResponse } from "./protocol/v2/ConfigRequirementsReadResponse.ts";
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

/** Which faster tiers the user's Codex runs, and the one its config asks for. */
export interface SpeedPolicy {
  /** The config's `service_tier`; `default` asks for standard speed. */
  readonly configured?: string;
  readonly fast: boolean;
  readonly ultrafast: boolean;
}

/** Every tier on, none configured: what Codex does with no config or requirements of the user's. */
export const OPEN_SPEEDS: SpeedPolicy = { fast: true, ultrafast: true };

/**
 * The tiers the user's config (`[features] fast_mode`, `ultrafast_mode`) and their organization's
 * managed requirements leave on, as Codex's own picker reads them. A server without independent speed
 * requirements gates Ultrafast with Fast.
 */
export const speedPolicy = (
  config: Pick<Config, "service_tier"> & { readonly features?: unknown },
  requirements: ConfigRequirementsReadResponse | undefined,
): SpeedPolicy => {
  const features = (typeof config.features === "object" ? config.features : null) as Record<
    string,
    unknown
  > | null;
  const required = requirements?.requirements?.featureRequirements ?? {};
  const fast = features?.["fast_mode"] !== false && required["fast_mode"] !== false;
  const ultrafast =
    features?.["ultrafast_mode"] !== false &&
    required["ultrafast_mode"] !== false &&
    (requirements?.supportsIndependentSpeedModes === true || required["fast_mode"] !== false);
  return { ...(config.service_tier ? { configured: config.service_tier } : {}), fast, ultrafast };
};

const SPEED_ORDER: ReadonlyArray<ModelSpeed> = ["standard", "fast", "ultrafast"];

/**
 * The speeds a model runs at for the signed-in account: its catalog's service tiers, which OpenAI
 * lists per model and per plan, where the policy leaves them on. Its default is what Codex runs when
 * no tier is sent: the configured tier where the model has it (`default`, or one it lacks, runs
 * standard), else the catalog's default for the model. Codex versions from before speed tiers list
 * none.
 */
export const speedsOf = (
  model: Partial<Pick<Model, "serviceTiers" | "defaultServiceTier">>,
  policy: SpeedPolicy,
): Pick<ModelInfo, "speeds" | "defaultSpeed"> => {
  const enabled = (speed: ModelSpeed) =>
    speed === "standard" || (speed === "fast" ? policy.fast : policy.ultrafast);
  const listed = new Set((model.serviceTiers ?? []).map((tier) => fromServiceTier(tier.id)));
  const speeds = SPEED_ORDER.filter((speed) => enabled(speed) && (speed === "standard" || listed.has(speed)));
  if (speeds.length < 2) return {};
  const pick = fromServiceTier(policy.configured ?? model.defaultServiceTier);
  return { speeds, defaultSpeed: pick !== undefined && speeds.includes(pick) ? pick : "standard" };
};

/**
 * `cacheSafe` says, per model slug, whether OpenAI's model catalog lets Codex change the model's
 * effort mid-conversation without starting its prompt cache over; a model it doesn't name falls back
 * to the ones measured.
 */
export const toModelInfo = (
  model: Model,
  cacheSafe?: ReadonlyMap<string, boolean>,
  speed: SpeedPolicy = OPEN_SPEEDS,
): ModelInfo => {
  const defaultEffort = fromCodexEffort(model.defaultReasoningEffort);
  return {
    provider: "codex",
    // `thread/start` takes the model slug.
    id: model.model,
    label: model.displayName,
    ...(model.description ? { description: model.description } : {}),
    efforts: ceriumEfforts(model.supportedReasoningEfforts.map((option) => option.reasoningEffort)),
    ...(defaultEffort ? { defaultEffort } : {}),
    ...((cacheSafe?.get(model.model) ?? CACHE_SAFE_EFFORT.has(model.model)) ? { cacheSafeEffort: true } : {}),
    ...speedsOf(model, speed),
    ...(model.isDefault ? { isDefault: true } : {}),
  };
};

/**
 * The models whose prompt cache survived an effort switch in a live check (0.164.0, medium → low,
 * with `reasoning_effort_override` on): Codex sends it as a `configuration_update`. GPT-5.6 models
 * start the cache over. Used where Codex's model catalog can't be read.
 */
const CACHE_SAFE_EFFORT: ReadonlySet<string> = new Set(["gpt-6-luna"]);

/**
 * The part of Codex's cached model catalog (`$CODEX_HOME/models_cache.json`, written by `codex`
 * from OpenAI's model list for the signed-in account) that says which models take an effort change
 * as a `configuration_update`, the flag Codex itself checks (`supports_reasoning_effort_updates`).
 * The file isn't part of the app-server protocol, so anything unexpected in it reads as no catalog.
 */
const ModelCatalog = Schema.fromJsonString(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        supports_reasoning_effort_updates: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
);

/** Which models keep their prompt cache across an effort change, by slug, from Codex's catalog. */
export const cacheSafeFromCatalog = (text: string): ReadonlyMap<string, boolean> | undefined =>
  Schema.decodeUnknownOption(ModelCatalog)(text).pipe(
    Option.map(
      ({ models }) =>
        new Map(
          models.map((model) => [model.slug, model.supports_reasoning_effort_updates === true] as const),
        ),
    ),
    Option.getOrUndefined,
  );

/** Asks the user's `codex` which models its picker offers. No thread is started. */
export const listCodexModels = Effect.fn("CodexAdapter.listModels")(function* (executablePath: string) {
  const server = yield* connect(executablePath);
  const models = yield* listAllModels(server, false).pipe(
    Effect.mapError(
      (cause) => new HarnessFailure({ provider: "codex", message: "Could not list Codex models", cause }),
    ),
  );
  // Read after `model/list`, which has Codex refresh the catalog when it's stale.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* fs.readFileString(path.join(server.codexHome, "models_cache.json")).pipe(
    Effect.map(cacheSafeFromCatalog),
    Effect.orElseSucceed(() => undefined),
  );
  // Which tiers run: the user's config and managed requirements can turn Fast or Ultrafast off. Either
  // unreadable leaves every tier the catalog lists.
  const config = yield* server.request("config/read", { includeLayers: false }).pipe(
    Effect.map((answer) => answer.config),
    Effect.orElseSucceed(() => ({ service_tier: null })),
  );
  const requirements = yield* server
    .request("configRequirements/read", undefined)
    .pipe(Effect.orElseSucceed(() => undefined));
  const speed = speedPolicy(config, requirements);
  return models.map((model) => toModelInfo(model, catalog, speed));
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
