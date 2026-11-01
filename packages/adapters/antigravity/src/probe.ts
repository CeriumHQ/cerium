import {
  AUTH_REQUIRED,
  connect,
  type AcpCommand,
  type AcpConnection,
  type Initialized,
} from "@cerium/adapter-acp";
import { findOnPath, HarnessFailure, scratchFolder } from "@cerium/harness";
import type { HarnessStatus, LoginProgress } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Queue, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { join } from "node:path";

import { INSTALL_HINT } from "./manifest.ts";

export const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "antigravity", message, cause });

/** No CLI is bundled and the hidden `agy acp` is deliberately not used as a fallback. */
export const findAntigravity = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const explicit = process.env["CERIUM_ANTIGRAVITY_PATH"];
  if (explicit)
    return (yield* fs.exists(explicit).pipe(Effect.mapError(failure("Could not locate Antigravity"))))
      ? Option.some(explicit)
      : Option.none<string>();
  for (const name of process.platform === "win32"
    ? ["agy_acp_server.exe"]
    : ["agy_acp_server.par", "agy_acp_server"]) {
    const found = yield* findOnPath(name);
    if (found[0] !== undefined) return Option.some(found[0]);
  }
  return Option.none<string>();
});

export const agentCommand = (executable: string): AcpCommand => ({
  provider: "antigravity",
  label: "Antigravity",
  executable,
  args: process.platform === "linux" ? ["--uid="] : [],
});

/** Only noncredential configuration is inspected. Never opens OAuth files or keychains. */
export const checkUserMcp = Effect.fn("Antigravity.checkUserMcp")(function* (include: boolean) {
  if (include) return;
  const fs = yield* FileSystem.FileSystem;
  const home = process.env["GEMINI_HOME"] || join(homedir(), ".gemini");
  const path = join(home, "config", "mcp_config.json");
  if (
    !(yield* fs
      .exists(path)
      .pipe(Effect.mapError(failure("Could not inspect Antigravity's MCP configuration"))))
  )
    return;
  const value = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(failure("Could not inspect Antigravity's MCP configuration")));
  // The runtime has no documented per-session switch to suppress global MCP. Fail closed instead
  // of editing it, copying credentials into an isolated profile, or silently loading those servers.
  if (!/^\s*(?:\{\s*\}|\{\s*"mcpServers"\s*:\s*\{\s*\}\s*\})\s*$/.test(value)) {
    return yield* failure(
      "Antigravity loads global MCP servers. Enable 'Include the harness's MCP servers' for this agent, or remove them with Antigravity's own settings. Cerium leaves that configuration unchanged.",
    )(path);
  }
});

export const probeAntigravity = Effect.fn("Antigravity.probe")(function* (
  cwd: string,
  onInitialized?: (initialized: Initialized) => void,
) {
  const executable = yield* findAntigravity;
  if (Option.isNone(executable))
    return {
      _tag: "HarnessMissing",
      provider: "antigravity",
      installHint: INSTALL_HINT,
    } satisfies HarnessStatus;
  const connection = yield* connect(agentCommand(executable.value));
  onInitialized?.(connection.initialized);
  const auth = yield* connection.request("session/new", { cwd, mcpServers: [] }).pipe(
    Effect.as({ _tag: "LoggedIn" } as const),
    Effect.catchIf(
      (error) => error._tag === "AcpRequestError" && error.code === AUTH_REQUIRED,
      () => Effect.succeed({ _tag: "LoggedOut", browserLogin: true } as const),
    ),
    Effect.mapError(failure("Could not check Antigravity account access")),
  );
  return {
    _tag: "HarnessInstalled",
    provider: "antigravity",
    executablePath: executable.value,
    version: connection.initialized.agentInfo?.version ?? "unknown",
    auth,
  } satisfies HarnessStatus;
}, Effect.scoped);

/** Native ACP 1.4 prints this notice outside JSON-RPC. No credential is parsed or returned. */
export const authorizationUrl = (line: string): string | undefined => {
  const prefix = "Open the following link to authenticate the ACP server: ";
  const at = line.indexOf(prefix);
  if (at < 0) return undefined;
  try {
    const url = new URL(line.slice(at + prefix.length).trim());
    return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

export const loginWith = Effect.fn("Antigravity.login")(function* (
  executable: string,
  cwd: string,
  emit: (progress: LoginProgress) => Effect.Effect<void>,
) {
  let last = "";
  const connection: AcpConnection = yield* connect({
    ...agentCommand(executable),
    onLine: (line) => {
      const url = authorizationUrl(line);
      if (url === undefined || url === last) return Effect.void;
      last = url;
      return emit({ _tag: "OpenUrl", url });
    },
  });
  yield* connection
    .request("authenticate", { methodId: "oauth-personal" })
    .pipe(Effect.mapError(failure("Antigravity sign-in failed")));
  yield* connection
    .request("session/new", { cwd, mcpServers: [] })
    .pipe(Effect.mapError(failure("Antigravity signed in but could not confirm account access")));
  yield* emit({ _tag: "SignedIn" });
}, Effect.scoped);

export const loginAntigravity = Stream.callback<
  LoginProgress,
  HarnessFailure,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>((queue) =>
  Effect.gen(function* () {
    const executable = yield* findAntigravity;
    if (Option.isNone(executable)) return yield* failure(INSTALL_HINT)(undefined);
    const cwd = yield* scratchFolder("antigravity", "cerium-antigravity");
    yield* loginWith(executable.value, cwd, (progress) => Queue.offer(queue, progress).pipe(Effect.asVoid));
    yield* Queue.end(queue);
  }).pipe(
    Effect.catch((error) => Queue.fail(queue, error)),
    Effect.forkScoped,
  ),
);
