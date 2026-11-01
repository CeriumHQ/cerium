import {
  choicesOf,
  currentModel,
  modelsOf,
  modelOption,
  SessionSetup,
  type AcpConnection,
} from "@cerium/adapter-acp";
import type { ModelInfo } from "@cerium/protocol";
import { Effect, Schema } from "effect";

import { failure } from "./probe.ts";

const decode = Schema.decodeUnknownEffect(SessionSetup);

/** Thinking choices belong to the selected model; never copy one model's levels onto every model. */
export const listAntigravityModels = Effect.fn("Antigravity.listModels")(function* (
  connection: AcpConnection,
  cwd: string,
) {
  const setup = yield* connection
    .request("session/new", { cwd, mcpServers: [] })
    .pipe(Effect.flatMap(decode), Effect.mapError(failure("Could not list Antigravity models")));
  const sessionId = setup.sessionId;
  if (sessionId === undefined) return yield* failure("Antigravity returned no model-list session")(setup);
  const initial = currentModel(setup.configOptions ?? [], setup.models);
  const picker = modelOption(setup.configOptions ?? []);
  const offered = picker === undefined ? [] : choicesOf(picker);
  const models: Array<ModelInfo> = [];
  for (const choice of offered) {
    const selected = yield* connection
      .request("session/set_config_option", {
        sessionId,
        configId: picker!.id,
        value: choice.value,
      })
      .pipe(
        Effect.flatMap(decode),
        Effect.mapError(failure(`Could not inspect ${choice.name}'s thinking levels`)),
      );
    const model = modelsOf("antigravity", selected).find((model) => model.id === choice.value);
    if (model !== undefined) {
      const { isDefault: _default, ...info } = model;
      models.push({ ...info, ...(model.id === initial ? { isDefault: true } : {}) });
    }
  }
  return models.length > 0 ? models : modelsOf("antigravity", setup);
});
