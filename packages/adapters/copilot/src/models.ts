import { HarnessUnavailable } from "@cerium/harness";
import type { ModelInfo, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import { Effect } from "effect";
import { ResponseError } from "vscode-jsonrpc/node";

import { SIGN_IN } from "./manifest.ts";

import { failure, record, string, type CopilotHost } from "./rpc.ts";

const efforts: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Copilot has no speed switch of its own: a model's fast mode sits in the picker as a model of its
 * own, named with `-fast` (`claude-opus-4.8-fast`). Cerium offers it as the model's Fast speed, like
 * OpenCode's `-fast` siblings.
 */
const FAST_SUFFIX = "-fast";

/** The id that serves `model` at `speed`: its `-fast` sibling where the catalog folded one in. */
export const servedAs = (
  model: string,
  speed: ModelSpeed | undefined,
  models: ReadonlyArray<ModelInfo>,
): string =>
  speed === "fast" && models.some((each) => each.id === model && each.speeds?.includes("fast") === true)
    ? model + FAST_SUFFIX
    : model;

/**
 * Each `-fast` row folded into its base model's speeds. A fast row whose base the account's policy
 * leaves out stays a model of its own.
 */
const foldFast = (rows: Map<string, ModelInfo>) => {
  for (const id of [...rows.keys()]) {
    if (!id.endsWith(FAST_SUFFIX)) continue;
    const base = rows.get(id.slice(0, -FAST_SUFFIX.length));
    if (base === undefined) continue;
    rows.delete(id);
    rows.set(base.id, { ...base, speeds: ["standard", "fast"], defaultSpeed: "standard" });
  }
};

export const listCopilotModels = (host: CopilotHost) =>
  host.request("models.list").pipe(
    Effect.catchIf(
      ({ cause }) => cause instanceof ResponseError && /not authenticated/i.test(cause.message),
      () =>
        Effect.fail(new HarnessUnavailable({ provider: "copilot", reason: "loggedOut", message: SIGN_IN })),
    ),
    Effect.flatMap((response) => {
      const models = record(response)?.["models"];
      if (!Array.isArray(models))
        return Effect.fail(failure("GitHub Copilot CLI returned an invalid model catalog")(undefined));
      const rows = new Map<string, ModelInfo>();
      for (const value of models) {
        const model = record(value);
        const id = string(model?.["id"]);
        if (
          !model ||
          !id ||
          ["disabled", "unconfigured"].includes(String(record(model["policy"])?.["state"]))
        )
          continue;
        const supported = model["supportedReasoningEfforts"];
        const offered = Array.isArray(supported)
          ? efforts.filter((effort) => supported.includes(effort))
          : [];
        const defaultEffort = offered.find((effort) => effort === model["defaultReasoningEffort"]);
        rows.set(id, {
          provider: "copilot",
          id,
          label: string(model["name"]) ?? id,
          efforts: offered,
          ...(defaultEffort === undefined ? {} : { defaultEffort }),
        });
      }
      foldFast(rows);
      return Effect.succeed([...rows.values()]);
    }),
  );
