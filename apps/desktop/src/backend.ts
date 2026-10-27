import { app, utilityProcess, type UtilityProcess } from "electron";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  failureOnExit,
  isBackendFailed,
  outputTail,
  type BackendFailure,
  type BackendFailureKind,
} from "./backendFailure.ts";
import { buildChannel } from "./updater.ts";
import { answerVault, isVaultRequest } from "./vault.ts";

// The packaged app's backend: the bundled dist/backend.mjs, run in an
// Electron utility process so it gets Electron's own Node and no console window. It reports where it
// listens over the process's port, so the token stays in memory; the UI asks for it through the
// preload bridge. Its output goes to backend.log in the app's logs folder; when it stops on a failure,
// the UI hears why (backendFailure.ts) and can start it again at once. It keeps this machine's
// Cerium sign-in through the shell, which encrypts it (vault.ts).

export interface BackendConnection {
  readonly url: string;
  readonly token: string;
}

/** How long the UI waits for a starting backend before it counts as unreachable and retries. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long a stopping backend gets to run its finalizers before it is killed. */
const STOP_TIMEOUT_MS = 5_000;
/** A backend that ran this long restarts at once after it stops; one failing sooner backs off. */
const HEALTHY_RUN_MS = 60_000;

const isConnection = (message: unknown): message is BackendConnection =>
  typeof message === "object" &&
  message !== null &&
  typeof (message as { url?: unknown }).url === "string" &&
  typeof (message as { token?: unknown }).token === "string";

/** Starts the backend with `initial` (shellPath.ts), restarting it whenever it stops. */
export const startBackend = (initial: NodeJS.ProcessEnv) => {
  let env = initial;
  const logs = app.getPath("logs");
  mkdirSync(logs, { recursive: true });
  const log = createWriteStream(join(logs, "backend.log"), { flags: "a" });

  let child: UtilityProcess | undefined;
  let connection: BackendConnection | undefined;
  let waiting: Array<(connection: BackendConnection) => void> = [];
  let stopping = false;
  let failures = 0;
  /** The next launch, while a failed backend waits to start again. */
  let relaunch: ReturnType<typeof setTimeout> | undefined;
  /** Why the backend last stopped, until one listens again. */
  let failure: BackendFailure | undefined;
  const failureListeners = new Set<(failure: BackendFailure | undefined) => void>();
  const setFailure = (next: BackendFailure | undefined) => {
    if (next === undefined && failure === undefined) return;
    failure = next;
    for (const listener of failureListeners) listener(next);
  };

  const launch = () => {
    relaunch = undefined;
    const tail = outputTail();
    /** What the backend said stopped it, which comes just before it exits. */
    let said: { kind: BackendFailureKind; message: string } | undefined;
    const startedAt = Date.now();
    const backend = utilityProcess.fork(
      join(import.meta.dirname, "backend.mjs"),
      [
        `--data-dir=${app.getPath("userData")}`,
        `--migrations-dir=${join(app.getAppPath(), "migrations")}`,
        `--channel=${buildChannel()}`,
        `--app-version=${app.getVersion()}`,
        // Another relay than Cerium's own, such as `wrangler dev` while developing.
        ...(process.env["CERIUM_RELAY_URL"] ? [`--relay-url=${process.env["CERIUM_RELAY_URL"]}`] : []),
      ],
      { serviceName: "Cerium backend", stdio: "pipe", env },
    );
    backend.stdout?.pipe(log, { end: false });
    backend.stderr?.pipe(log, { end: false });
    backend.stdout?.on("data", tail.write);
    backend.stderr?.on("data", tail.write);
    backend.on("message", (message: unknown) => {
      if (isVaultRequest(message)) {
        void answerVault(message).then((reply) => backend.postMessage(reply));
        return;
      }
      if (isBackendFailed(message)) {
        said = { kind: message.kind, message: message.message };
        return;
      }
      if (!isConnection(message)) return;
      connection = message;
      setFailure(undefined);
      for (const resolve of waiting) resolve(message);
      waiting = [];
    });
    backend.once("exit", (code) => {
      child = undefined;
      connection = undefined;
      log.write(`Cerium backend exited with code ${code}\n`);
      if (stopping) return;
      setFailure(failureOnExit(said, code, tail.read(), Date.now()));
      failures = Date.now() - startedAt >= HEALTHY_RUN_MS ? 0 : failures + 1;
      relaunch = setTimeout(launch, failures === 0 ? 0 : Math.min(30_000, 1000 * 2 ** (failures - 1)));
    });
    child = backend;
  };
  launch();

  /** Where the UI connects, once the backend listens. */
  const connectionOf = (): Promise<BackendConnection> => {
    if (connection !== undefined) return Promise.resolve(connection);
    return new Promise((resolve, reject) => {
      const ready = (listening: BackendConnection) => {
        clearTimeout(timeout);
        resolve(listening);
      };
      const timeout = setTimeout(() => {
        waiting = waiting.filter((other) => other !== ready);
        reject(new Error("Cerium's backend didn't start in time."));
      }, CONNECT_TIMEOUT_MS);
      waiting.push(ready);
    });
  };

  return {
    connection: connectionOf,
    /** Why the backend last stopped, while none listens since. */
    failure: (): BackendFailure | undefined => failure,
    /** Calls back whenever the backend stops on a failure, or listens again after one; returns how to stop. */
    onFailure: (listener: (failure: BackendFailure | undefined) => void): (() => void) => {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
    /** Starts a backend waiting out its back-off now, with the back-off reset. */
    restart: () => {
      if (stopping || relaunch === undefined) return;
      clearTimeout(relaunch);
      failures = 0;
      launch();
    },
    /**
     * Gives the backend another PATH: the running one takes it for what it starts next, once it
     * listens (and so listens to the shell), and any that starts after it starts with it.
     */
    setPath: (path: string) => {
      env = { ...env, PATH: path };
      const running = child;
      void connectionOf().then(
        () => {
          if (child === running) running?.postMessage({ _tag: "SetPath", path });
        },
        () => undefined,
      );
    },
    /** Asks the backend to shut down, so its finalizers run, and kills it if it takes too long. */
    stop: (): Promise<void> =>
      new Promise((resolve) => {
        stopping = true;
        const running = child;
        if (running === undefined) {
          resolve();
          return;
        }
        const kill = setTimeout(() => running.kill(), STOP_TIMEOUT_MS);
        running.once("exit", () => {
          clearTimeout(kill);
          log.end();
          resolve();
        });
        running.postMessage("stop");
      }),
  };
};
