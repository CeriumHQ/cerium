import {
  connect,
  findExecutable,
  needsLogin,
  probeWorkspace,
  readCliVersion,
  loginRequired as acpLoginRequired,
} from "@cerium/acp";
import { compareVersions } from "@cerium/harness";
import type { HarnessStatus, ModelInfo } from "@cerium/protocol";
import { Effect } from "effect";

import {
  INSTALL_HINT,
  LOGIN_COMMAND,
  MINIMUM_VERSION,
  PROVIDER,
  antigravityHarness,
  failure,
} from "./manifest.ts";
import { readSessionDetails, toModelInfos } from "./models.ts";

export const findAntigravityExecutable = findExecutable("agy");

export const loginRequired = () => acpLoginRequired(antigravityHarness);

/** `agy acp` over stdio, with `flags` after it. */
export const connectAntigravity = (executable: string, cwd: string, flags: ReadonlyArray<string> = []) =>
  connect(antigravityHarness, { executable, args: ["acp", "--stdio", ...flags], cwd });

interface Discovery {
  readonly status: HarnessStatus;
  readonly models: ReadonlyArray<ModelInfo>;
}

export const discoverAntigravity = Effect.fn("Antigravity.discover")(function* (
  configuredExecutable: string | undefined,
) {
  const executablePath = configuredExecutable ?? (yield* findAntigravityExecutable);
  if (executablePath === undefined) {
    return {
      status: { _tag: "HarnessMissing", provider: PROVIDER, installHint: INSTALL_HINT },
      models: [],
    } satisfies Discovery;
  }

  const version = yield* readCliVersion(antigravityHarness, executablePath, "agy");
  const installed = { _tag: "HarnessInstalled", provider: PROVIDER, executablePath, version } as const;
  const loggedOut = { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } as const;
  if (compareVersions(version, MINIMUM_VERSION) < 0) {
    return {
      status: {
        ...installed,
        auth: loggedOut,
        versionStatus: "tooOld",
        updateCommand: "agy update",
        limit: {
          blocks: ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"],
          reason: `Antigravity CLI ${MINIMUM_VERSION} or newer is required for ACP.`,
        },
      },
      models: [],
    } satisfies Discovery;
  }

  // `initialize` offers authentication methods regardless of login state. A session with no prompt
  // distinguishes saved login from -32000 and returns the account's model catalog in one request.
  const cwd = yield* probeWorkspace(antigravityHarness);
  const acp = yield* connectAntigravity(executablePath, cwd, ["--include-default-customizations=false"]);
  const result = yield* acp.query("session/new", { cwd, mcpServers: [] }).pipe(
    Effect.map((value) => ({ signedIn: true as const, value })),
    Effect.catchIf(needsLogin, () => Effect.succeed({ signedIn: false as const })),
    Effect.mapError(acp.refused("session/new")),
  );
  if (!result.signedIn) {
    return { status: { ...installed, auth: loggedOut }, models: [] } satisfies Discovery;
  }

  const details = yield* readSessionDetails(result.value).pipe(
    Effect.mapError(() => failure("Antigravity returned an invalid model catalog")),
  );
  yield* acp.call("session/close", { sessionId: details.sessionId });
  const models = toModelInfos(details);
  if (models.length === 0) return yield* failure("Antigravity returned no models");

  const modes = details.configOptions.find(({ id }) => id === "mode")?.options;
  const hasAuto = modes?.some(({ value }) => value === "auto") === true;
  return {
    status: {
      ...installed,
      auth: { _tag: "LoggedIn" },
      limit: {
        blocks: hasAuto ? ["readOnly"] : ["readOnly", "auto"],
        reason: hasAuto
          ? "Antigravity does not provide a verified read-only mode."
          : "Antigravity does not provide a verified read-only mode or offer Auto mode on this account.",
      },
    },
    models,
  } satisfies Discovery;
}, Effect.scoped);

export const probeAntigravity = discoverAntigravity(undefined).pipe(Effect.map(({ status }) => status));
