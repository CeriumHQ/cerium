import type { AcpCommand, AcpConnection } from "@cerium/adapter-acp";
import { METHOD_NOT_FOUND } from "@cerium/adapter-acp";
import { findOnPath, HarnessFailure, parseVersion } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";

import { INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "grok", message, cause });

const Inspection = Schema.Struct({ mcpServers: Schema.Array(Schema.Unknown) });
const decodeInspection = Schema.decodeUnknownEffect(Schema.fromJsonString(Inspection));

/** Grok merges native MCP with session injection and exposes no supported per-session exclusion. */
export const checkUserMcp = Effect.fn("Grok.checkUserMcp")(function* (
  executable: string,
  cwd: string,
  include: boolean,
) {
  if (include) return;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const inspection = yield* spawner
    .string(
      ChildProcess.make(executable, ["inspect", "--json"], {
        cwd,
        shell: /\.cmd$/i.test(executable),
      }),
    )
    .pipe(
      Effect.flatMap(decodeInspection),
      Effect.mapError(failure("Could not inspect Grok's MCP configuration")),
    );
  if (inspection.mcpServers.length > 0)
    return yield* failure(
      "Grok loads its configured MCP servers alongside injected servers. Enable 'Include the harness's MCP servers' for this agent, or remove them with Grok's own settings. Cerium leaves that configuration unchanged.",
    )(undefined);
});

/**
 * Finds the user's installed `grok`: where its installer puts it (`$GROK_HOME/bin`, `~/.grok/bin` by
 * default), else on PATH, where npm installs a `.cmd` shim on Windows.
 */
export const findGrokExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";
  const home = process.env["GROK_HOME"] || path.join(homedir(), ".grok");
  const installed = path.join(home, "bin", windows ? "grok.exe" : "grok");
  if (yield* fs.exists(installed).pipe(Effect.orElseSucceed(() => false))) return Option.some(installed);
  const candidates = yield* findOnPath("grok");
  const usable = windows ? candidates.find((candidate) => /\.(exe|cmd)$/i.test(candidate)) : candidates[0];
  return Option.fromNullishOr(usable);
});

/** `grok agent stdio` on its own process: not a shared leader, so the session's settings stay its own. */
export const agentCommand = (executable: string, cwd?: string): AcpCommand => ({
  provider: "grok",
  label: "Grok Build",
  executable,
  args: ["agent", "--no-leader", "stdio"],
  // Grok's documented switch for its subagent (task) tool: Cerium's agents delegate through the bus.
  env: { GROK_SUBAGENTS: "0" },
  // npm's shim is a batch file, which only a shell starts.
  shell: /\.cmd$/i.test(executable),
  ...(cwd === undefined ? {} : { cwd }),
});

/** What `_x.ai/auth/check_subscription` says Cerium reads: whether it's signed in, and the plan. */
const Subscription = Schema.Struct({
  authenticated: Schema.Boolean,
  meta: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        subscription_tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
        auth_mode: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const decodeSubscription = Schema.decodeUnknownEffect(Subscription);

/** How Grok is signed in, read from its status alone; the account's address is never read. */
export const authStatusOf = (subscription: typeof Subscription.Type): AuthStatus => {
  if (!subscription.authenticated) return { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND };
  const plan = subscription.meta?.subscription_tier?.trim();
  const method = subscription.meta?.auth_mode?.trim();
  return {
    _tag: "LoggedIn",
    ...(method ? { method: method === "Oidc" ? "grok.com" : method } : {}),
    ...(plan ? { plan } : {}),
  };
};

/** Whether the agent is signed in, by Grok's own subscription check. */
export const readAuth = (connection: AcpConnection) =>
  connection.request("_x.ai/auth/check_subscription", {}).pipe(
    Effect.flatMap((answer) =>
      decodeSubscription(answer).pipe(Effect.mapError(failure("Unexpected subscription check"))),
    ),
    Effect.map(authStatusOf),
    // An agent without the check still answers sessions, which say so when it is signed out.
    Effect.catchIf(
      (error) => error._tag === "AcpRequestError" && error.code === METHOD_NOT_FOUND,
      () => Effect.succeed<AuthStatus>({ _tag: "LoggedIn" }),
    ),
    Effect.mapError((error) =>
      error._tag === "HarnessFailure" ? error : failure("Could not check the Grok sign-in")(error),
    ),
  );

/** Probes with `auth`, which reads the sign-in from an agent the adapter shares between calls. */
export const probeGrok = (auth: (executable: string) => Effect.Effect<AuthStatus, HarnessFailure>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executable = yield* findGrokExecutable;
    if (Option.isNone(executable)) {
      return { _tag: "HarnessMissing", provider: "grok", installHint: INSTALL_HINT } satisfies HarnessStatus;
    }
    const output = yield* spawner
      .string(ChildProcess.make(executable.value, ["--version"], { shell: /\.cmd$/i.test(executable.value) }))
      .pipe(Effect.mapError(failure("Could not run `grok --version`")));
    const version = parseVersion(output);
    if (version === undefined) {
      return yield* new HarnessFailure({
        provider: "grok",
        message: "Could not read the Grok Build version",
        cause: output,
      });
    }
    return {
      _tag: "HarnessInstalled",
      provider: "grok",
      executablePath: executable.value,
      version,
      auth: yield* auth(executable.value),
    } satisfies HarnessStatus;
  });
