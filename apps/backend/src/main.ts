// Starts Cerium's backend.
//
//   node apps/backend/src/main.ts [--data-dir=<dir>] [--connection-file=<path>] [--migrations-dir=<dir>]
//
// --data-dir         where the database and chat folders live (default: ~/.cerium)
// --connection-file  where to write { url, token } for the UI; used in development, removed on exit
// --migrations-dir   the store's migrations, for a bundled backend (default: beside @cerium/store)
//
// The packaged app runs this bundled in an Electron utility process (apps/desktop/src/backend.ts),
// which receives { url, token } over its parent port and sends "stop" there to shut it down.

import type { CatalogEntry } from "@cerium/orchestrator";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpServer } from "effect/http";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { backendLayer } from "./layers.ts";
import { RPC_PATH } from "./rpc.ts";

const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const dataDirectory = resolve(flag("data-dir") ?? join(homedir(), ".cerium"));
const connectionFile = flag("connection-file");
const migrationsFolder = flag("migrations-dir");
const token = randomBytes(32).toString("hex");
mkdirSync(dataDirectory, { recursive: true });

/** The port Electron gives a utility process to talk to the shell; absent anywhere else. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
}
const shell = (process as { parentPort?: ParentPort }).parentPort;

// Stopping goes through runMain's signal handling, so the backend's finalizers run.
shell?.on("message", ({ data }) => {
  if (data === "stop") process.emit("SIGTERM", "SIGTERM");
});

// Until onboarding builds the catalog with the user, these lead it, followed by every model the
// logged-in harnesses offer (`catalogFrom`).
const catalog: ReadonlyArray<CatalogEntry> = [
  { alias: "opus", provider: "claude", model: "opus", description: "Hard problems, design and review" },
  { alias: "sonnet", provider: "claude", model: "sonnet", description: "Everyday coding" },
  { alias: "haiku", provider: "claude", model: "haiku", description: "Quick lookups and simple tasks" },
];

/** Tells the UI where to connect once the server is listening. */
const Announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const url = `${HttpServer.formatAddress(server.address).replace(/^http/, "ws")}${RPC_PATH}`;
    yield* Effect.log(`Cerium backend listening on ${url} (data: ${dataDirectory})`);
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
  catalog,
  token,
  ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
};

Layer.launch(Announce.pipe(Layer.provideMerge(backendLayer(options)))).pipe(NodeRuntime.runMain);
