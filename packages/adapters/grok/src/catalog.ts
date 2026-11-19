import { HarnessUnavailable, findOnPath, parseVersion, scratchFolder } from "@cerium/harness";
import { ReasoningEffort, type AuthStatus, type ModelInfo } from "@cerium/protocol";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { INSTALL_HINT, LOGIN_COMMAND, SIGNED_OUT } from "./manifest.ts";
import { array, connect, failure, object, string, type GrokConnection } from "./rpc.ts";

const isEffort = Schema.is(ReasoningEffort);
const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const loginRequired = (cause: unknown) => cause === -32000;

export const signedOut = () =>
  new HarnessUnavailable({ provider: "grok", reason: "loggedOut", message: SIGNED_OUT });

export const initialize = (client: GrokConnection) =>
  client
    .request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "cerium", version: "0.0.0" },
      _meta: { clientIdentifier: "cerium" },
    })
    .pipe(
      Effect.flatMap((value) => {
        const info = object(value);
        return info?.["protocolVersion"] === 1
          ? Effect.succeed(info)
          : Effect.fail(failure("Grok Build did not negotiate ACP version 1"));
      }),
    );

export const authenticate = Effect.fn("GrokAdapter.authenticate")(function* (
  client: GrokConnection,
  info: Readonly<Record<string, unknown>>,
) {
  const meta = object(info["_meta"]);
  const ids = array(info["authMethods"]).map((method) => object(method)?.["id"]);
  const preferred = meta?.["defaultAuthMethodId"];
  // Interactive auth belongs to the user's CLI. Only ask the provider to use its existing login.
  const method = [preferred, "cached_token", "xai.api_key"].find(
    (id) => (id === "cached_token" || id === "xai.api_key") && ids.includes(id),
  );
  if (method === undefined) return yield* signedOut();
  yield* client
    .request("authenticate", { methodId: method, _meta: { headless: true } })
    .pipe(Effect.mapError((error) => (loginRequired(error.cause) ? signedOut() : error)));
  return method === "xai.api_key" ? "apiKey" : "grokLogin";
});

export const grokModels = (state: unknown): ReadonlyArray<ModelInfo> => {
  const catalog = object(state);
  return array(catalog?.["availableModels"]).flatMap((entry) => {
    const model = object(entry);
    const id = string(model?.["modelId"]);
    if (id === undefined) return [];
    const description = string(model?.["description"]);
    const options = array(object(model?.["_meta"])?.["reasoningEfforts"]).map(object);
    const defaultEffort = options.find((option) => option?.["default"] === true)?.["value"];
    return [
      {
        provider: "grok",
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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executable = (yield* findOnPath("grok")).find(
      (path) => process.platform !== "win32" || /\.exe$/i.test(path),
    );
    if (executable === undefined)
      return {
        status: { _tag: "HarnessMissing", provider: "grok", installHint: INSTALL_HINT },
        models: [],
      } as const;

    const version = yield* spawner.string(ChildProcess.make(executable, ["--version"])).pipe(
      Effect.map(parseVersion),
      Effect.mapError((cause) => failure("Could not run grok --version", cause)),
    );
    if (version === undefined) return yield* failure("Could not read the Grok Build version");

    const cwd = yield* scratchFolder("grok", "grok-probe");
    const client = yield* connect(executable, cwd, undefined, false);
    const info = yield* initialize(client);
    const auth: AuthStatus = yield* authenticate(client, info).pipe(
      Effect.map((method): AuthStatus => ({ _tag: "LoggedIn", method })),
      Effect.catchTag("HarnessUnavailable", () =>
        Effect.succeed({ _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } as const),
      ),
    );
    const status = {
      _tag: "HarnessInstalled",
      provider: "grok",
      executablePath: executable,
      version,
      auth,
    } as const;
    return { status, models: grokModels(object(info["_meta"])?.["modelState"]) };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: "20 seconds",
    orElse: () => Effect.fail(failure("Grok Build did not finish its ACP status check")),
  }),
);
