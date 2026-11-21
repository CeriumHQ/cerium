import {
  array,
  connect,
  findExecutable,
  loginRequired,
  needsLogin,
  readCliVersion,
  record,
  string,
  type AcpConnection,
} from "@cerium/acp";
import { scratchFolder } from "@cerium/harness";
import { ReasoningEffort, type AuthStatus, type ModelInfo } from "@cerium/protocol";
import { Effect, Schema } from "effect";

import { INSTALL_HINT, LOGIN_COMMAND, PROVIDER, failure, grokHarness } from "./manifest.ts";

const isEffort = Schema.is(ReasoningEffort);
const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const signedOut = () => loginRequired(grokHarness);

/**
 * `grok agent stdio`, Grok Build's ACP agent, without its updater, telemetry, workflows or goals.
 * Without the user's MCP servers, Grok's imports of other harnesses' servers are off too.
 */
export const connectGrok = (
  executable: string,
  cwd: string,
  sandbox?: "off" | "workspace" | "read-only",
  includeUserMcpServers = true,
) =>
  connect(
    grokHarness,
    {
      executable,
      args: ["--no-auto-update", "agent", "--no-leader", "stdio"],
      cwd,
      env: {
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_TELEMETRY_ENABLED: "0",
        GROK_STORAGE_MODE: "local",
        GROK_WORKFLOWS: "0",
        GROK_GOAL: "0",
        GROK_SANDBOX_AUTO_ALLOW_BASH: "0",
        ...(includeUserMcpServers
          ? {}
          : {
              GROK_CLAUDE_MCPS_ENABLED: "0",
              GROK_CURSOR_MCPS_ENABLED: "0",
              GROK_CODEX_MCPS_ENABLED: "0",
              GROK_MANAGED_MCPS_ENABLED: "0",
              GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "0",
            }),
        ...(sandbox === undefined ? {} : { GROK_SANDBOX: sandbox }),
      },
    },
    { meta: { clientIdentifier: "cerium" } },
  );

export const authenticate = Effect.fn("GrokAdapter.authenticate")(function* (acp: AcpConnection) {
  const ids = array(acp.agent.authMethods).map((method) => record(method)?.["id"]);
  const preferred = acp.agent.meta?.["defaultAuthMethodId"];
  // Interactive auth belongs to the user's CLI. Only ask the provider to use its existing login.
  const method = [preferred, "cached_token", "xai.api_key"].find(
    (id) => (id === "cached_token" || id === "xai.api_key") && ids.includes(id),
  );
  if (method === undefined) return yield* signedOut();
  yield* acp
    .query("authenticate", { methodId: method, _meta: { headless: true } })
    .pipe(Effect.mapError((error) => (needsLogin(error) ? signedOut() : acp.refused("authenticate")(error))));
  return method === "xai.api_key" ? "apiKey" : "grokLogin";
});

export const grokModels = (state: unknown): ReadonlyArray<ModelInfo> => {
  const catalog = record(state);
  return array(catalog?.["availableModels"]).flatMap((entry) => {
    const model = record(entry);
    const id = string(model?.["modelId"]);
    if (id === undefined) return [];
    const description = string(model?.["description"]);
    const options = array(record(model?.["_meta"])?.["reasoningEfforts"]).map(record);
    const defaultEffort = options.find((option) => option?.["default"] === true)?.["value"];
    return [
      {
        provider: PROVIDER,
        id,
        label: string(model?.["name"]) ?? id,
        ...(description === undefined ? {} : { description }),
        efforts: efforts.filter((effort) =>
          options.some((option) => (option?.["value"] ?? option?.["id"]) === effort),
        ),
        ...(isEffort(defaultEffort) ? { defaultEffort } : {}),
        ...(catalog?.["currentModelId"] === id ? { isDefault: true } : {}),
      },
    ];
  });
};

export const inspectGrok = Effect.fn("GrokAdapter.inspect")(
  function* () {
    const executable = yield* findExecutable("grok");
    if (executable === undefined)
      return {
        status: { _tag: "HarnessMissing", provider: PROVIDER, installHint: INSTALL_HINT },
        models: [],
      } as const;

    const version = yield* readCliVersion(grokHarness, executable, "grok");
    const cwd = yield* scratchFolder(PROVIDER, "grok-probe");
    const acp = yield* connectGrok(executable, cwd, undefined, false);
    const auth: AuthStatus = yield* authenticate(acp).pipe(
      Effect.map((method): AuthStatus => ({ _tag: "LoggedIn", method })),
      Effect.catchTag("HarnessUnavailable", () =>
        Effect.succeed({ _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } as const),
      ),
    );
    const status = {
      _tag: "HarnessInstalled",
      provider: PROVIDER,
      executablePath: executable,
      version,
      auth,
    } as const;
    return { status, models: grokModels(acp.agent.meta?.["modelState"]) };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: "20 seconds",
    orElse: () => Effect.fail(failure("Grok Build did not finish its ACP status check")),
  }),
);
