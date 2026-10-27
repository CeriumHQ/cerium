// Starts Cerium's backend.
//
//   node apps/backend/src/main.ts [--data-dir=<dir>] [--connection-file=<path>] [--migrations-dir=<dir>]
//                                 [--relay-url=<url>] [--channel=<stable|nightly|dev>] [--app-version=<v>]
//
// --data-dir         where the database and chat folders live (default: ~/.cerium)
// --connection-file  where to write { url, token } for the UI; used in development, removed on exit
// --migrations-dir   the store's migrations, for a bundled backend (default: beside @cerium/store)
// --relay-url        the Cerium relay this machine signs in to (default: Cerium's own)
// --channel          the build this is, which the account's devices list shows (default: dev)
// --app-version      this build's version, shown the same way (default: dev)
//
// The packaged app runs this bundled in an Electron utility process (apps/desktop/src/backend.ts),
// which receives { url, token } over its parent port, or what stopped it (src/failure.ts), and sends
// "stop" there to shut it down. It
// also keeps this machine's sign-in there, encrypted (src/vault.ts).

import type { Channel } from "@cerium/protocol";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, FileSystem, Layer, Path } from "effect";
import { HttpServer } from "effect/http";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { DEFAULT_RELAY_URL } from "@cerium/account";
import { thisInstallation, thisMachine } from "./device.ts";
import { backendFailed, messageChain, type BackendFailed } from "./failure.ts";
import { backendLayer } from "./layers.ts";
import { RPC_PATH } from "./rpc.ts";
import { isSetPath, parentPort as shell } from "./shell.ts";
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
mkdirSync(dataDirectory, { recursive: true });

// Stopping goes through runMain's signal handling, so the backend's finalizers run. A PATH the user's
// shell gave differently from the one this started on, which the shell asks for meanwhile, is what
// the harnesses and terminals started from now on find their programs on.
shell?.on("message", ({ data }) => {
  if (data === "stop") process.emit("SIGTERM", "SIGTERM");
  if (isSetPath(data)) process.env["PATH"] = data.path;
});

/** Whether the server listens yet, which tells a failure at startup from a crash after it. */
let listening = false;

// An exception nothing caught still stops the backend as Node does, but the shell hears why first.
process.on("uncaughtExceptionMonitor", (error) => {
  shell?.postMessage({
    _tag: "BackendFailed",
    kind: "crash",
    message: messageChain(error),
  } satisfies BackendFailed);
});

/** Tells the UI where to connect once the server is listening. */
const Announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const url = `${HttpServer.formatAddress(server.address).replace(/^http/, "ws")}${RPC_PATH}`;
    yield* Effect.log(`Cerium backend listening on ${url} (data: ${dataDirectory})`);
    listening = true;
    shell?.postMessage({ url, token });
    if (connectionFile === undefined) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(connectionFile), { recursive: true });
    yield* fs.writeFileString(connectionFile, JSON.stringify({ url, token }));
    yield* Effect.addFinalizer(() => fs.remove(connectionFile).pipe(Effect.ignore));
  }),
);

const options = {
  dataDirectory,
  token,
  ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
  account: {
    relayUrl,
    device: thisMachine(channel, appVersion),
    installation: thisInstallation(dataDirectory),
  },
  vault: shell === undefined ? fileVault(join(dataDirectory, "account.json")) : shellVault(shell),
  effortRouterKey:
    shell === undefined
      ? fileEffortRouterKey(join(dataDirectory, "effort-router.json"))
      : shellEffortRouterKey(shell),
};

Layer.launch(Announce.pipe(Layer.provideMerge(backendLayer(options)))).pipe(
  // The shell shows the user why the backend stopped; runMain still logs the whole cause.
  Effect.tapCause((cause) =>
    Effect.sync(() => {
      if (!Cause.hasInterruptsOnly(cause)) shell?.postMessage(backendFailed(cause, listening));
    }),
  ),
  NodeRuntime.runMain,
);
