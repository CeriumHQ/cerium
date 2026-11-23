import {
  isDaemonRunning,
  readRuntimeConnection,
  readRuntimeStatus,
  type RuntimeConnection,
} from "@cerium/backend/runtime";
import type { Channel } from "@cerium/protocol";
import { RPC_VERSION } from "@cerium/rpc";

import type { BackendFailure } from "./backendFailure.ts";
import {
  checkRpcCompatibility,
  probeRpcEndpoint,
  startHostService,
  updateHostDaemon,
  type HostDiscoveryResult,
  type HostServiceInfo,
} from "./hostDaemon.ts";

export interface AttachedConnection {
  readonly url: string;
  readonly token: string;
}

export interface AttachedBackendOptions {
  readonly initial: Exclude<HostDiscoveryResult, { readonly kind: "absent" }>;
  readonly service: HostServiceInfo;
  readonly getEnv: () => NodeJS.ProcessEnv;
  readonly expectedRpcVersion?: number;
  readonly connectTimeoutMs?: number;
  readonly restartGraceMs?: number;
  readonly connectedPollMs?: number;
  readonly waitingPollMs?: number;
  readonly actionWaitMs?: number;
  readonly probe?: (url: string, token: string) => Promise<boolean>;
  readonly startService?: () => Promise<void>;
  readonly updateHost?: (options: {
    readonly service: HostServiceInfo;
    readonly channel?: Channel;
    readonly env?: NodeJS.ProcessEnv;
  }) => Promise<{ readonly ok: boolean; readonly output: string }>;
  readonly onFailure: (failure: BackendFailure | undefined) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RESTART_GRACE_MS = 5_000;
const DEFAULT_CONNECTED_POLL_MS = 2_500;
const DEFAULT_WAITING_POLL_MS = 350;
const DEFAULT_ACTION_WAIT_MS = 15_000;

const sameRecord = (a: RuntimeConnection | undefined, b: RuntimeConnection | undefined): boolean =>
  a !== undefined && b !== undefined && a.pid === b.pid && a.url === b.url && a.token === b.token;

const versionLabel = (version: string) => (version === "dev" ? "dev" : `v${version}`);

const hostStoppedFailure = (
  serviceInstalled: boolean,
  detail?: string,
  busy?: "starting" | "updating",
): BackendFailure => ({
  kind: "hostStopped",
  message:
    detail ??
    (serviceInstalled
      ? "The Cerium Host service is stopped. Start it to keep using your Cerium Host threads."
      : "The local cerium-host process stopped. Start cerium-host again to reconnect."),
  log: "",
  at: Date.now(),
  host: {
    serviceInstalled,
    canFallback: true,
    ...(busy === undefined ? {} : { busy }),
  },
});

const hostOutdatedFailure = (options: {
  readonly version: string;
  readonly hostRpcVersion?: number;
  readonly expectedRpcVersion: number;
  readonly serviceInstalled: boolean;
  readonly detail?: string;
  readonly busy?: "starting" | "updating";
}): BackendFailure => ({
  kind: "hostOutdated",
  message:
    options.detail ??
    (options.hostRpcVersion === undefined
      ? `Running cerium-host (${versionLabel(options.version)}) predates desktop attach. Run cerium-host update to connect.`
      : `Running cerium-host (${versionLabel(options.version)}, RPC v${options.hostRpcVersion}) is older than this app (RPC v${options.expectedRpcVersion}). Run cerium-host update to connect.`),
  log: "",
  at: Date.now(),
  host: {
    serviceInstalled: options.serviceInstalled,
    command: "cerium-host update",
    ...(options.busy === undefined ? {} : { busy: options.busy }),
  },
});

const desktopOutdatedFailure = (options: {
  readonly version: string;
  readonly hostRpcVersion: number;
  readonly expectedRpcVersion: number;
  readonly serviceInstalled: boolean;
}): BackendFailure => ({
  kind: "desktopOutdated",
  message: `Running cerium-host (${versionLabel(options.version)}, RPC v${options.hostRpcVersion}) is newer than this desktop app (RPC v${options.expectedRpcVersion}). Update Cerium Desktop to connect.`,
  log: "",
  at: Date.now(),
  host: { serviceInstalled: options.serviceInstalled },
});

const hostUnreachableFailure = (serviceInstalled: boolean, dataDirectory: string): BackendFailure => ({
  kind: "hostUnreachable",
  message: `The running cerium-host in ${dataDirectory} did not respond on its local RPC socket.`,
  log: "",
  at: Date.now(),
  host: { serviceInstalled, canFallback: true },
});

const initialDirectory = (
  initial: Exclude<HostDiscoveryResult, { readonly kind: "absent" }>,
  service: HostServiceInfo,
): string =>
  initial.kind === "ready"
    ? initial.connection.dataDirectory
    : initial.dataDirectory || service.dataDirectory;

/**
 * Manages an attached session to a local `cerium-host` daemon: returns its `{ url, token }`,
 * watches for restarts (re-discovering updated ports/tokens), surfaces version mismatches or
 * stopped-service states without silently splitting state, and detaches cleanly on `stop()`.
 */
export const createAttachedBackend = (options: AttachedBackendOptions) => {
  const expectedRpcVersion = options.expectedRpcVersion ?? RPC_VERSION;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const restartGraceMs = options.restartGraceMs ?? DEFAULT_RESTART_GRACE_MS;
  const connectedPollMs = options.connectedPollMs ?? DEFAULT_CONNECTED_POLL_MS;
  const waitingPollMs = options.waitingPollMs ?? DEFAULT_WAITING_POLL_MS;
  const actionWaitMs = options.actionWaitMs ?? DEFAULT_ACTION_WAIT_MS;
  const probe = options.probe ?? probeRpcEndpoint;
  const runStartService = options.startService ?? (() => startHostService({ env: options.getEnv() }));
  const runUpdateHost = options.updateHost ?? updateHostDaemon;

  const serviceInstalled = options.service.installed;
  let dataDirectory = initialDirectory(options.initial, options.service);
  let active: RuntimeConnection | undefined =
    options.initial.kind === "ready" ? options.initial.connection : undefined;
  let lastIncompatible:
    | {
        readonly version: string;
        readonly hostRpcVersion?: number;
        readonly channel?: Channel;
      }
    | undefined =
    options.initial.kind === "incompatible"
      ? {
          version: options.initial.version,
          ...(options.initial.hostRpcVersion === undefined
            ? {}
            : { hostRpcVersion: options.initial.hostRpcVersion }),
          ...(options.initial.channel === undefined ? {} : { channel: options.initial.channel }),
        }
      : undefined;

  let failure: BackendFailure | undefined;
  let stopping = false;
  let busy: "starting" | "updating" | undefined;
  let lostAt: number | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let syncing: Promise<void> | undefined;

  interface Waiter {
    readonly resolve: (connection: AttachedConnection) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }
  let waiting: Array<Waiter> = [];

  const rejectWaiters = (message: string) => {
    const pending = waiting;
    waiting = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
  };

  const resolveWaiters = (connection: AttachedConnection) => {
    const pending = waiting;
    waiting = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(connection);
    }
  };

  const setFailure = (next: BackendFailure | undefined) => {
    failure = next;
    options.onFailure(next);
    if (next !== undefined && next.host?.busy === undefined) {
      rejectWaiters(next.message);
    }
  };

  const applyInitialFailure = () => {
    switch (options.initial.kind) {
      case "ready":
        return;
      case "serviceStopped":
        setFailure(hostStoppedFailure(true));
        return;
      case "unreachable":
        setFailure(hostUnreachableFailure(serviceInstalled, dataDirectory));
        return;
      case "incompatible":
        if (options.initial.direction === "desktopOutdated" && options.initial.hostRpcVersion !== undefined) {
          setFailure(
            desktopOutdatedFailure({
              version: options.initial.version,
              hostRpcVersion: options.initial.hostRpcVersion,
              expectedRpcVersion,
              serviceInstalled,
            }),
          );
        } else {
          setFailure(
            hostOutdatedFailure({
              version: options.initial.version,
              ...(options.initial.hostRpcVersion === undefined
                ? {}
                : { hostRpcVersion: options.initial.hostRpcVersion }),
              expectedRpcVersion,
              serviceInstalled,
            }),
          );
        }
    }
  };
  applyInitialFailure();

  const findLiveDirectory = (): string | undefined => {
    const directories = options.service.candidateDirectories.includes(dataDirectory)
      ? [dataDirectory, ...options.service.candidateDirectories.filter((dir) => dir !== dataDirectory)]
      : [dataDirectory, ...options.service.candidateDirectories];
    return directories.find((dir) => isDaemonRunning(dir));
  };

  const schedulePoll = () => {
    clearTimeout(pollTimer);
    if (stopping) return;
    const delay = active !== undefined && failure === undefined ? connectedPollMs : waitingPollMs;
    pollTimer = setTimeout(() => {
      void syncHost();
    }, delay);
  };

  const syncHost = (syncOptions: { readonly forceProbe?: boolean } = {}): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (syncing !== undefined) return syncing;
    const run = (async () => {
      const runningDir = findLiveDirectory();
      if (runningDir === undefined) {
        const hadActive = active !== undefined;
        active = undefined;
        if (hadActive && lostAt === undefined) lostAt = Date.now();
        if (busy !== undefined) return;
        if (lostAt === undefined || Date.now() - lostAt >= restartGraceMs) {
          if (failure?.kind !== "hostStopped" || failure.host?.busy !== undefined) {
            setFailure(hostStoppedFailure(serviceInstalled));
          }
        }
        return;
      }

      dataDirectory = runningDir;
      const record = readRuntimeConnection(runningDir);
      if (record === undefined) {
        const hadActive = active !== undefined;
        active = undefined;
        if (hadActive && lostAt === undefined) lostAt = Date.now();
        if (busy !== undefined) return;
        const runtime = readRuntimeStatus(runningDir);
        if (runtime !== undefined && (lostAt === undefined || Date.now() - lostAt >= restartGraceMs)) {
          lastIncompatible = { version: runtime.version };
          setFailure(
            hostOutdatedFailure({
              version: runtime.version,
              expectedRpcVersion,
              serviceInstalled,
            }),
          );
        }
        return;
      }

      const compatibility = checkRpcCompatibility(record.rpcVersion, expectedRpcVersion);
      if (compatibility !== "compatible") {
        active = undefined;
        lostAt = undefined;
        lastIncompatible = {
          version: record.version,
          hostRpcVersion: record.rpcVersion,
          channel: record.channel,
        };
        if (busy !== undefined) return;
        if (compatibility === "desktopOutdated") {
          setFailure(
            desktopOutdatedFailure({
              version: record.version,
              hostRpcVersion: record.rpcVersion,
              expectedRpcVersion,
              serviceInstalled,
            }),
          );
        } else if (failure?.kind !== "hostOutdated" || failure.host?.busy !== undefined) {
          setFailure(
            hostOutdatedFailure({
              version: record.version,
              hostRpcVersion: record.rpcVersion,
              expectedRpcVersion,
              serviceInstalled,
            }),
          );
        }
        return;
      }

      if (sameRecord(record, active) && !syncOptions.forceProbe && failure === undefined) {
        return;
      }

      const live = await probe(record.url, record.token);
      if (stopping) return;
      if (!live) {
        active = undefined;
        if (lostAt === undefined) lostAt = Date.now();
        if (busy !== undefined) return;
        if (Date.now() - lostAt >= restartGraceMs) {
          setFailure(hostUnreachableFailure(serviceInstalled, runningDir));
        }
        return;
      }

      active = record;
      lostAt = undefined;
      lastIncompatible = undefined;
      if (failure !== undefined) setFailure(undefined);
      resolveWaiters({ url: record.url, token: record.token });
    })().finally(() => {
      syncing = undefined;
      schedulePoll();
    });
    syncing = run;
    return run;
  };

  schedulePoll();

  const waitForReady = (timeoutMs: number): Promise<AttachedConnection> =>
    new Promise((resolveWait, rejectWait) => {
      const waiter: Waiter = {
        resolve: resolveWait,
        reject: rejectWait,
        timer: setTimeout(() => {
          waiting = waiting.filter((other) => other !== waiter);
          rejectWait(new Error("Cerium Host didn't become ready in time."));
        }, timeoutMs),
      };
      waiting.push(waiter);
    });

  const connectionOf = (): Promise<AttachedConnection> => {
    if (stopping) return Promise.reject(new Error("Cerium is closing."));
    const current = readRuntimeConnection(dataDirectory);
    if (sameRecord(current, active) && active !== undefined && failure === undefined) {
      return Promise.resolve({ url: active.url, token: active.token });
    }
    if (!sameRecord(current, active) && active !== undefined) {
      active = undefined;
      if (lostAt === undefined) lostAt = Date.now();
    }
    const candidateCompatible =
      current !== undefined && checkRpcCompatibility(current.rpcVersion, expectedRpcVersion) === "compatible";
    void syncHost({ forceProbe: true });
    if (!candidateCompatible && failure !== undefined && failure.host?.busy === undefined) {
      return Promise.reject(new Error(failure.message));
    }
    return waitForReady(connectTimeoutMs);
  };

  const pollUntilReady = async (deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (!stopping && Date.now() < deadline) {
      await syncHost({ forceProbe: true });
      if (active !== undefined) return true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, waitingPollMs));
    }
    return active !== undefined;
  };

  return {
    connection: connectionOf,
    failure: (): BackendFailure | undefined => failure,
    restart: () => {
      if (stopping || busy !== undefined) return;
      void syncHost({ forceProbe: true });
    },
    startHostService: async () => {
      if (stopping || busy !== undefined) return;
      busy = "starting";
      setFailure(hostStoppedFailure(serviceInstalled, "Starting Cerium Host service…", "starting"));
      try {
        await runStartService();
        const ready = await pollUntilReady(actionWaitMs);
        busy = undefined;
        if (!ready && !stopping) {
          await syncHost({ forceProbe: true });
          if (active === undefined && (failure === undefined || failure.host?.busy !== undefined)) {
            setFailure(
              hostStoppedFailure(
                serviceInstalled,
                "Cerium Host service didn't start in time. Check cerium-host service logs.",
              ),
            );
          }
        }
      } catch (error) {
        busy = undefined;
        if (stopping) return;
        const detail = error instanceof Error ? error.message : String(error);
        setFailure(hostStoppedFailure(serviceInstalled, `Couldn't start Cerium Host service: ${detail}`));
      }
    },
    updateHost: async () => {
      if (stopping || busy !== undefined) return;
      busy = "updating";
      const snapshot = lastIncompatible ?? { version: "unknown" };
      setFailure(
        hostOutdatedFailure({
          version: snapshot.version,
          ...(snapshot.hostRpcVersion === undefined ? {} : { hostRpcVersion: snapshot.hostRpcVersion }),
          expectedRpcVersion,
          serviceInstalled,
          detail: "Updating Cerium Host…",
          busy: "updating",
        }),
      );
      try {
        const result = await runUpdateHost({
          service: options.service,
          ...(snapshot.channel === undefined ? {} : { channel: snapshot.channel }),
          env: options.getEnv(),
        });
        if (stopping) return;
        if (!result.ok) {
          busy = undefined;
          setFailure(
            hostOutdatedFailure({
              version: snapshot.version,
              ...(snapshot.hostRpcVersion === undefined ? {} : { hostRpcVersion: snapshot.hostRpcVersion }),
              expectedRpcVersion,
              serviceInstalled,
              detail: result.output,
            }),
          );
          return;
        }
        const manualOrNoop = /npm install|is up to date/i.test(result.output);
        const ready = manualOrNoop ? false : await pollUntilReady(actionWaitMs);
        busy = undefined;
        if (!ready && !stopping) {
          await syncHost({ forceProbe: true });
          if (active === undefined) {
            const detail =
              result.output.trim() ||
              "Cerium Host updated, but didn't reconnect with a compatible version yet. Restart cerium-host or retry.";
            setFailure(
              hostOutdatedFailure({
                version: snapshot.version,
                ...(snapshot.hostRpcVersion === undefined ? {} : { hostRpcVersion: snapshot.hostRpcVersion }),
                expectedRpcVersion,
                serviceInstalled,
                detail,
              }),
            );
          }
        }
      } catch (error) {
        busy = undefined;
        if (stopping) return;
        const detail = error instanceof Error ? error.message : String(error);
        setFailure(
          hostOutdatedFailure({
            version: snapshot.version,
            ...(snapshot.hostRpcVersion === undefined ? {} : { hostRpcVersion: snapshot.hostRpcVersion }),
            expectedRpcVersion,
            serviceInstalled,
            detail: `Couldn't update Cerium Host: ${detail}`,
          }),
        );
      }
    },
    /** Detaches cleanly from `cerium-host` without stopping or signaling the daemon. */
    stop: async (): Promise<void> => {
      stopping = true;
      clearTimeout(pollTimer);
      pollTimer = undefined;
      rejectWaiters("Detached from Cerium Host.");
    },
  };
};
