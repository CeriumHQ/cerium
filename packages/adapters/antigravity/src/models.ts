import { EFFORTS, record } from "@cerium/acp";
import type { ModelInfo } from "@cerium/protocol";
import { Effect, Schema } from "effect";

import { PROVIDER, failure } from "./manifest.ts";

const Config = Schema.Struct({
  id: Schema.NonEmptyString,
  currentValue: Schema.NonEmptyString,
  options: Schema.Array(
    Schema.Struct({
      value: Schema.NonEmptyString,
      name: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
    }),
  ),
});

const SessionDetails = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  models: Schema.Struct({
    currentModelId: Schema.NonEmptyString,
    availableModels: Schema.Array(
      Schema.Struct({
        modelId: Schema.NonEmptyString,
      }),
    ),
  }),
  configOptions: Schema.Array(Schema.Unknown),
});

const readOptions = (options: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(Config))(
    options.filter((option) => {
      const id = record(option)?.["id"];
      return id === "model" || id === "thought_level" || id === "mode";
    }),
  );

export const readSessionDetails = (result: unknown) =>
  Schema.decodeUnknownEffect(SessionDetails)(result).pipe(
    Effect.flatMap((details) =>
      readOptions(details.configOptions).pipe(Effect.map((configOptions) => ({ ...details, configOptions }))),
    ),
  );

type SessionDetails = Effect.Success<ReturnType<typeof readSessionDetails>>;

export const readConfig = (result: unknown) =>
  Schema.decodeUnknownEffect(Schema.Struct({ configOptions: Schema.Array(Schema.Unknown) }))(result).pipe(
    Effect.flatMap(({ configOptions }) => readOptions(configOptions)),
    Effect.mapError(() => failure("Antigravity returned invalid session configuration")),
  );

/** ACP's model picker groups the legacy model ids by family. The legacy ids enumerate each family's variants. */
export const toModelInfos = ({ configOptions, models }: SessionDetails): ReadonlyArray<ModelInfo> => {
  const model = configOptions.find(({ id }) => id === "model");
  if (model === undefined) return [];
  const thought = configOptions.find(({ id }) => id === "thought_level");
  const variants = new Set(models.availableModels.map(({ modelId }) => modelId));
  return model.options.map(({ value, name, description }) => {
    const isDefault = value === model.currentValue;
    const efforts =
      thought === undefined ? [] : EFFORTS.filter((effort) => variants.has(`${value}-${effort}`));
    const defaultEffort = isDefault ? efforts.find((effort) => effort === thought?.currentValue) : undefined;
    return {
      provider: PROVIDER,
      id: value,
      label: name || value,
      efforts,
      ...(description ? { description } : {}),
      ...(isDefault ? { isDefault } : {}),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    };
  });
};
