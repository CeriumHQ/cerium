// Starts Cerium's backend.
//
//   node apps/backend/src/main.ts [--data-dir=<dir>] [--connection-file=<path>] [--migrations-dir=<dir>]
//                                 [--relay-url=<url>] [--channel=<stable|nightly|dev>] [--app-version=<v>]
//                                 [--name=<label>] [--headless] [--sign-in] [--status]
//
// --data-dir         where the database and chat folders live (default: ~/.cerium)
// --connection-file  where to write { url, token } for the UI; used in development, removed on exit
// --migrations-dir   the store's migrations, for a bundled backend (default: beside @cerium/store)
// --relay-url        the Cerium relay this machine signs in to (default: Cerium's own)
// --channel          the build this is, which the account's devices list shows (default: dev)
// --app-version      this build's version, shown the same way (default: dev)
// --name             use this device label in place of the hostname
// --headless         identify this machine as a headless host
// --sign-in          run on its own: sign this machine in, printing the page to confirm at (src/headless.ts)
// --status           say how this machine's saved sign-in stands, and exit
//
// The packaged app runs this bundled in an Electron utility process (apps/desktop/src/backend.ts),
// which receives { url, token } over its parent port, or what stopped it (src/failure.ts), and sends
// "stop" there to shut it down. It
// also keeps this machine's sign-in there, encrypted (src/vault.ts).

import type { Channel } from "@cerium/protocol";
import { RPC_VERSION } from "@cerium/rpc";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, FileSystem, Layer, Logger, Path, Stream } from "effect";
import { HttpServer } from "effect/http";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Account, DEFAULT_RELAY_URL } from "@cerium/account";
import { thisInstallation, thisMachine } from "./device.ts";
import { backendFailed, messageChain, type BackendFailed } from "./failure.ts";
import { forgetGitRepository } from "./gitRepositoryVariables.ts";
import {
  headlessFlags,
  headlessHandoff,
  manualHandoff,
  readSavedSignIn,
  savedStatus,
  terminalLines,
  watchAccount,
} from "./headless.ts";
import { crashReport, reportLogger } from "./reports.ts";
import { backendLayer } from "./layers.ts";
import { RPC_PATH } from "./rpc.ts";
import { desktopPort, isSetPath, parentPort as supervisor } from "./shell.ts";
import { acquireDaemonLock, readRuntimeStatus } from "./runtime.ts";
import { loginShellPath, mergePaths } from "./shellPath.ts";
import { fileEffortRouterKey, fileVault, shellEffortRouterKey, shellVault } from "./vault.ts";

const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const dataDirectory = resolve(flag("data-dir") ?? join(homedir(), ".cerium"));
const connectionFile = flag("connection-file");
const migrationsFolder = flag("migrations-dir");
const relayUrl = flag("relay-url") ?? DEFAULT_RELAY_URL;
const channelFlag = flag("channel");
const channel: Channel = channelFlag === "stable" || channelFlag === "nightly" ? channelFlag : "dev";
const appVersion = flag("app-version") ?? "dev";
const token = randomBytes(32).toString("hex");
const headless = headlessFlags(process.argv);
const device = thisMachine(channel, appVersion, headless);
const shell = headless.headless ? undefined : desktopPort;
const vaultFile = join(dataDirectory, "account.json");

if (headless.status) {
  const status = savedStatus(shell === undefined ? readSavedSignIn(vaultFile) : undefined, {
    relayUrl,
    deviceName: device.name,
  });
  const runtime = readRuntimeStatus(dataDirectory);
  const running = runtime ? `Running (PID ${runtime.pid}, ${runtime.connection}).` : "Stopped.";
  process.stdout.write(`${status.text}\n${running}\nData: ${dataDirectory}\n`);
  process.exit(status.signedIn ? 0 : 1);
}

// Each project's git, and the harnesses' and terminals' started here, finds its repository from its
// own folder: a GIT_DIR from whatever started the backend (a hook, `git rebase --exec`) would put
// every project's git on that one repository.
forgetGitRepository(process.env);

// Stopping goes through runMain's signal handling, so the backend's finalizers run. A PATH the user's
// shell gave differently from the one this started on, which the shell asks for meanwhile, is what
// the harnesses and terminals started from now on find their programs on.
supervisor?.on("message", ({ data }) => {
  if (data === "stop") process.emit("SIGTERM", "SIGTERM");
  if (isSetPath(data)) process.env["PATH"] = data.path;
});

// A supervised host exits with its supervisor so service managers can restart the pair.
if (process.send) process.once("disconnect", () => process.emit("SIGTERM", "SIGTERM"));

/** Whether the server listens yet, which tells a failure at startup from a crash after it. */
let listening = false;

// An exception nothing caught still stops the backend as Node does, but the shell hears why first,
// and reports it.
process.on("uncaughtExceptionMonitor", (error) => {
  supervisor?.postMessage({
    _tag: "BackendFailed",
    kind: "crash",
    message: messageChain(error),
  } satisfies BackendFailed);
  supervisor?.postMessage(crashReport("crash", error, { kind: "uncaught" }));
});

/** Logs annotated as reports (src/reports.ts) go to the shell too, beside the usual log. */
const Reports = Logger.layer([reportLogger((report) => supervisor?.postMessage(report))], {
  mergeWithExisting: true,
});

/** Tells the UI where to connect once the server is listening. */
const announce = (runtime: ReturnType<typeof acquireDaemonLock>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const url = `${HttpServer.formatAddress(server.address).replace(/^http/, "ws")}${RPC_PATH}`;
      yield* Effect.log(`Cerium backend listening on ${url} (data: ${dataDirectory})`);
      listening = true;
      supervisor?.postMessage({ url, token });
      if (headless.headless) {
        runtime.publishConnection({ url, token, rpcVersion: RPC_VERSION, channel });
        yield* Effect.addFinalizer(() => Effect.sync(() => runtime.clearConnection()));
      }
      if (connectionFile === undefined) return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(connectionFile), { recursive: true });
      yield* fs.writeFileString(connectionFile, JSON.stringify({ url, token }), { mode: 0o600 });
      yield* Effect.addFinalizer(() => fs.remove(connectionFile).pipe(Effect.ignore));
    }),
  );

/** The port the sign-in page hands its code to, while this machine signs in on its own. */
let signInPort: number | undefined;

const serve = Effect.gen(function* () {
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => acquireDaemonLock(dataDirectory, device)),
    (lock) => Effect.sync(() => lock.release()),
  );
  if (shell === undefined && process.platform !== "win32" && (headless.headless || !process.stdin.isTTY)) {
    const path = yield* Effect.promise(() => loginShellPath(process.env));
    if (path !== undefined) process.env["PATH"] = mergePaths(path, process.env["PATH"] ?? "");
  }
  const handoff = headless.headless
    ? manualHandoff()
    : shell === undefined && process.stdin.isTTY
      ? headlessHandoff(terminalLines, (port) => (signInPort = port))
      : undefined;
  const options = {
    dataDirectory,
    token,
    ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
    account: {
      relayUrl,
      device,
      installation: thisInstallation(dataDirectory),
      ...(handoff === undefined ? {} : { handoff }),
    },
    vault: shell === undefined ? fileVault(vaultFile) : shellVault(shell),
    effortRouterKey:
      shell === undefined
        ? fileEffortRouterKey(join(dataDirectory, "effort-router.json"))
        : shellEffortRouterKey(shell),
  };

  /** On its own, the terminal says how the account stands, and signs in with `--sign-in`. */
  const Headless =
    shell === undefined
      ? watchAccount({
          signIn: headless.signIn,
          describe: {
            deviceName: device.name,
            paste: !headless.headless && process.stdin.isTTY === true,
            manual: headless.headless,
          },
          port: () => signInPort,
        })
      : Layer.empty;

  const Status = Layer.effectDiscard(
    Effect.gen(function* () {
      const account = yield* Account;
      yield* account.changes.pipe(
        Stream.runForEach((state) => Effect.sync(() => runtime.update(state))),
        Effect.forkScoped,
      );
    }),
  );
  return yield* Layer.launch(
    Layer.mergeAll(announce(runtime), Headless, Status).pipe(Layer.provideMerge(backendLayer(options))),
  );
});
serve.pipe(
  Effect.scoped,
  Effect.provide(Reports),
  // The shell shows the user why the backend stopped, and reports it; runMain still logs the whole cause.
  Effect.tapCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterruptsOnly(cause)) return;
      const failed = backendFailed(cause, listening);
      supervisor?.postMessage(failed);
      supervisor?.postMessage(
        crashReport(failed.kind === "crash" ? "crash" : "startup", Cause.squash(cause), {
          kind: failed.kind,
        }),
      );
    }),
  ),
  NodeRuntime.runMain,
);
