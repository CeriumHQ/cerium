import { HarnessUnavailable } from "@cerium/harness";
import type { ModelInfo, ReasoningEffort } from "@cerium/protocol";
import { Effect } from "effect";
import { ResponseError } from "vscode-jsonrpc/node";

import { SIGN_IN } from "./manifest.ts";

import { failure, record, string, type CopilotHost } from "./rpc.ts";

const efforts: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

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
      return Effect.succeed([...rows.values()]);
    }),
  );
