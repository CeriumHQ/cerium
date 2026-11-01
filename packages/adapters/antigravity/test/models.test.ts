import { connect, type AcpCommand } from "@cerium/adapter-acp";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { listAntigravityModels } from "../src/models.ts";

it.live("queries each model's own thinking levels rather than copying the current model's", () =>
  Effect.gen(function* () {
    const command: AcpCommand = {
      provider: "antigravity",
      label: "Antigravity fixture",
      executable: process.execPath,
      args: [join(import.meta.dirname, "fixtures", "fake-agent.mjs")],
    };
    const models = yield* listAntigravityModels(yield* connect(command), import.meta.dirname);
    assert.deepStrictEqual(
      models.map((model) => [model.id, model.efforts, model.isDefault]),
      [
        ["gemini-flash", ["low", "medium", "high"], true],
        ["gemini-pro", ["high", "max"], undefined],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
