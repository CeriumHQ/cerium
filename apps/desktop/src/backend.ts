import { ShellUpdateRequest, type RemoteUpdates, type UpdateCommand } from "@cerium/rpc";
import { Schema } from "effect";
import { app, utilityProcess, type UtilityProcess } from "electron";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

import { createAttachedBackend } from "./attachedBackend.ts";
import {
  failureOnExit,
  isBackendFailed,
  outputTail,
  type BackendFailure,
  type BackendFailureKind,
} from "./backendFailure.ts";
import { asCrashReport } from "./crashReport.ts";
import { reportCrash } from "./crashReports.ts";
import { discoverHostDaemon, inspectHostService } from "./hostDaemon.ts";
import { buildChannel } from "./updater.ts";

/** A failure the backend reports (apps/backend/src/reports.ts), checked by `asCrashReport`. */
const isCrashReportMessage = (message: unknown): boolean =>
  typeof message === "object" && message !== null && (message as { _tag?: unknown })._tag === "CrashReport";
import { answerVault, isVaultRequest } from "./vault.ts";

// The packaged app's backend: either attached to a running `cerium-host` daemon on this machine
// (attachedBackend.ts), or the bundled dist/backend.mjs run in an Electron utility process so it
// gets Electron's own Node and no console window. When managed by Electron, it reports where it
// listens over the process's port, so the token stays in memory; the UI asks for it through the
// preload bridge. Its output goes to backend.log in the app's logs folder; when it stops on a
// failure, the UI hears why (backendFailure.ts) and can start it again at once. It keeps this
// machine's Cerium sign-in through the shell, which encrypts it (vault.ts).

export interface BackendConnection {
  readonly url: string;
  readonly token: string;
}

export interface StartBackendOptions {
  /** Skip `cerium-host` discovery and always spawn Electron's own backend (used by `--smoke-test`). */
  readonly disableAttach?: boolean;
}

/** How long the UI waits for a starting backend before it counts as unreachable and retries. */
const CONNECT_TIMEOUT_MS = 15_000;
/** How long a stopping backend gets to run its finalizers before it is killed. */
const STOP_TIMEOUT_MS = 5_000;
/** A backend that ran this long restarts at once after it stops; one failing sooner backs off. */
const HEALTHY_RUN_MS = 60_000;

const isUpdateRequest = Schema.is(ShellUpdateRequest);

const isConnection = (message: unknown): message is BackendConnection =>
  typeof message === "object" &&
  message !== null &&
  typeof (message as { url?: unknown }).url === "string" &&
  typeof (message as { token?: unknown }).token === "string";

/**
 * Attaches to a local `cerium-host` daemon when present/installed, else starts Electron's managed
 * backend with `initial` (shellPath.ts) and restarts it whenever it stops.
 */
export const startBackend = async (
  initial: NodeJS.ProcessEnv,
  update: (command: UpdateCommand | null) => RemoteUpdates,
  options: StartBackendOptions = {},
) => {
  let env = initial;
  let log: WriteStream | undefined;
  const openLog = () => {
    if (log !== undefined) return log;
    const logs = app.getPath("logs");
    mkdirSync(logs, { recursive: true });
    log = createWriteStream(join(logs, "backend.log"), { flags: "a" });
    return log;
  };

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

  let attachedBackend: ReturnType<typeof createAttachedBackend> | undefined;
  const attachedListeners = new Set<(attached: boolean) => void>();
  const notifyAttached = (attached: boolean) => {
    for (const listener of attachedListeners) listener(attached);
  };

  const launch = () => {
    relaunch = undefined;
    const stream = openLog();
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
    backend.stdout?.pipe(stream, { end: false });
    backend.stderr?.pipe(stream, { end: false });
    backend.stdout?.on("data", tail.write);
    backend.stderr?.on("data", tail.write);
    backend.on("message", (message: unknown) => {
      if (isUpdateRequest(message)) {
        backend.postMessage({ type: "desktopUpdateState", updates: update(message.command) });
        return;
      }
      if (isVaultRequest(message)) {
        void answerVault(message).then((reply) => backend.postMessage(reply));
        return;
      }
      if (isBackendFailed(message)) {
        said = { kind: message.kind, message: message.message };
        return;
      }
      if (isCrashReportMessage(message)) {
        const report = asCrashReport(message, "backend");
        if (report !== undefined) reportCrash(report);
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
      stream.write(`Cerium backend exited with code ${code}\n`);
      if (stopping) return;
      setFailure(failureOnExit(said, code, tail.read(), Date.now()));
      // One that said why reported it itself; one that couldn't, such as a native crash, is reported here.
      if (said === undefined) {
        reportCrash({
          process: "backend",
          category: "crash",
          kind: "exited",
          name: "BackendExited",
          message: `The backend exited with code ${code}`,
          context: { code },
        });
      }
      failures = Date.now() - startedAt >= HEALTHY_RUN_MS ? 0 : failures + 1;
      relaunch = setTimeout(launch, failures === 0 ? 0 : Math.min(30_000, 1000 * 2 ** (failures - 1)));
    });
    child = backend;
  };

  const service = options.disableAttach ? undefined : inspectHostService({ env });
  const discovery = service ? await discoverHostDaemon({ service }) : ({ kind: "absent" } as const);
  if (service !== undefined && discovery.kind !== "absent") {
    attachedBackend = createAttachedBackend({
      initial: discovery,
      service,
      getEnv: () => env,
      onFailure: setFailure,
    });
  } else {
    launch();
  }

  /** Where the UI connects, once the backend listens. */
  const connectionOf = (): Promise<BackendConnection> => {
    if (attachedBackend !== undefined) return attachedBackend.connection();
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
    attached: (): boolean => attachedBackend !== undefined,
    onAttachedChange: (listener: (attached: boolean) => void): (() => void) => {
      attachedListeners.add(listener);
      return () => attachedListeners.delete(listener);
    },
    connection: connectionOf,
    publishUpdate: (updates: RemoteUpdates) => {
      if (attachedBackend !== undefined) return;
      child?.postMessage({ type: "desktopUpdateState", updates });
    },
    /** Why the backend last stopped, while none listens since. */
    failure: (): BackendFailure | undefined => failure,
    /** Calls back whenever the backend stops on a failure, or listens again after one; returns how to stop. */
    onFailure: (listener: (failure: BackendFailure | undefined) => void): (() => void) => {
      failureListeners.add(listener);
      return () => failureListeners.delete(listener);
    },
    /** Starts a backend waiting out its back-off now, or re-probes `cerium-host` in attach mode. */
    restart: () => {
      if (stopping) return;
      if (attachedBackend !== undefined) {
        attachedBackend.restart();
        return;
      }
      if (relaunch === undefined) return;
      clearTimeout(relaunch);
      failures = 0;
      launch();
    },
    startHostService: async () => {
      if (attachedBackend !== undefined) await attachedBackend.startHostService();
    },
    updateHost: async () => {
      if (attachedBackend !== undefined) await attachedBackend.updateHost();
    },
    /** Explicitly leaves attach mode for this run and starts Electron's own local backend. */
    useLocalBackend: () => {
      if (stopping || attachedBackend === undefined) return;
      const previous = attachedBackend;
      attachedBackend = undefined;
      void previous.stop();
      setFailure(undefined);
      notifyAttached(false);
      launch();
    },
    /**
     * Gives the backend another PATH: the running one takes it for what it starts next, once it
     * listens (and so listens to the shell), and any that starts after it starts with it.
     */
    setPath: (path: string) => {
      env = { ...env, PATH: path };
      if (attachedBackend !== undefined) return;
      const running = child;
      void connectionOf().then(
        () => {
          if (child === running) running?.postMessage({ _tag: "SetPath", path });
        },
        () => undefined,
      );
    },
    /** Detaches from `cerium-host` without stopping it, or shuts down Electron's own backend. */
    stop: (): Promise<void> => {
      stopping = true;
      if (attachedBackend !== undefined) {
        return attachedBackend.stop();
      }
      return new Promise((resolve) => {
        const finish = () => {
          if (log !== undefined) {
            const stream = log;
            log = undefined;
            stream.end(() => resolve());
          } else {
            resolve();
          }
        };
        const running = child;
        if (running === undefined) {
          finish();
          return;
        }
        const kill = setTimeout(() => running.kill(), STOP_TIMEOUT_MS);
        running.once("exit", () => {
          clearTimeout(kill);
          finish();
        });
        running.postMessage("stop");
      });
    },
  };
};
