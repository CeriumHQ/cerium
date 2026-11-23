import type { AccountState, Channel } from "@cerium/protocol";
import { Option, Schema } from "effect";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RuntimeStatus = Schema.Struct({
  pid: Schema.Int,
  startedAt: Schema.Finite,
  name: Schema.String,
  version: Schema.String,
  connection: Schema.Literals(["starting", "signed-out", "signing-in", "connecting", "online", "offline"]),
  deviceId: Schema.optionalKey(Schema.String),
});
export type RuntimeStatus = typeof RuntimeStatus.Type;
const decodeStatus = Schema.decodeOption(Schema.fromJsonString(RuntimeStatus));

const RuntimeConnection = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  rpcVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  version: Schema.String,
  channel: Schema.Literals(["stable", "nightly", "dev"]),
  dataDirectory: Schema.String,
});
export type RuntimeConnection = typeof RuntimeConnection.Type;
const decodeConnection = Schema.decodeOption(Schema.fromJsonString(RuntimeConnection));

const busy = (error: unknown) =>
  typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5; // SQLITE_BUSY

const cantOpen = (error: unknown) =>
  typeof error === "object" && error !== null && "errcode" in error && error.errcode === 14; // SQLITE_CANTOPEN

const isLoopbackWsUrl = (value: string): boolean => {
  const url = URL.parse(value);
  if (!url || url.protocol !== "ws:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
};

/** Whether a live daemon currently holds the exclusive OS lock for this directory. */
export const isDaemonRunning = (directory: string): boolean => {
  const lockfile = join(directory, "daemon.lock");
  if (!existsSync(lockfile)) return false;
  try {
    using lock = new DatabaseSync(lockfile, { readOnly: true });
    lock.prepare("SELECT name FROM sqlite_schema").all();
    return false;
  } catch (error) {
    if (busy(error)) return true;
    if (cantOpen(error) && !existsSync(lockfile)) return false;
    throw error;
  }
};

/** Only a process holding the OS lock for this directory can publish live status. */
export const readRuntimeStatus = (directory: string): RuntimeStatus | undefined => {
  if (!isDaemonRunning(directory)) return undefined;
  try {
    return Option.getOrUndefined(decodeStatus(readFileSync(join(directory, "runtime.json"), "utf8")));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

/**
 * Reads the local RPC handoff published by a live headless daemon in `directory`.
 * Verified against `daemon.lock` so stale files left after a crash are ignored.
 */
export const readRuntimeConnection = (directory: string): RuntimeConnection | undefined => {
  if (!isDaemonRunning(directory)) return undefined;
  try {
    const record = Option.getOrUndefined(
      decodeConnection(readFileSync(join(directory, "connection.json"), "utf8")),
    );
    if (record === undefined || record.token.length === 0 || !isLoopbackWsUrl(record.url)) return undefined;
    return record;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

/**
 * Keep ownership on a dedicated SQLite file. The OS releases it after a crash, and simultaneous
 * starts always lock the same inode. Only a daemon holds the exclusive lock that readers detect.
 */
const lockDirectory = (directory: string, daemon: boolean) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const lock = new DatabaseSync(join(directory, "daemon.lock"), { timeout: 100 });
  try {
    lock.exec(daemon ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE");
    rmSync(join(directory, "runtime.json"), { force: true });
    rmSync(join(directory, "runtime.json.tmp"), { force: true });
    rmSync(join(directory, "connection.json"), { force: true });
    rmSync(join(directory, "connection.json.tmp"), { force: true });
  } catch (error) {
    lock.close();
    if (busy(error)) throw new Error(`Cerium is already running in ${directory}.`, { cause: error });
    throw error;
  }
  return lock;
};

/** Serialize a local account command with daemon startup and other account commands. */
export const acquireDataLock = (directory: string) => {
  const lock = lockDirectory(directory, false);
  return {
    release: () => {
      if (lock.isOpen) lock.close();
    },
  };
};

const writeSecretFile = (file: string, pending: string, contents: string) => {
  writeFileSync(pending, contents, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(pending, 0o600);
  renameSync(pending, file);
};

/** Publish live status until this daemon releases ownership of its data directory. */
export const acquireDaemonLock = (directory: string, device: { name: string; version: string }) => {
  const lock = lockDirectory(directory, true);
  const file = join(directory, "runtime.json");
  const pending = file + ".tmp";
  const connectionFile = join(directory, "connection.json");
  const connectionPending = connectionFile + ".tmp";
  const base = { pid: process.pid, startedAt: Date.now(), name: device.name, version: device.version };
  let released = false;
  let previous: string | undefined;
  const write = (state: Pick<RuntimeStatus, "connection" | "deviceId">) => {
    const contents = JSON.stringify({ ...base, ...state });
    if (released || contents === previous) return;
    writeSecretFile(file, pending, contents);
    previous = contents;
  };
  try {
    write({ connection: "starting" });
  } catch (error) {
    lock.close();
    throw error;
  }
  return {
    update(state: AccountState) {
      if (state._tag === "SignedIn") write({ deviceId: state.deviceId, connection: state.connection });
      else write({ connection: state._tag === "SigningIn" ? "signing-in" : "signed-out" });
    },
    publishConnection(connection: {
      readonly url: string;
      readonly token: string;
      readonly rpcVersion: number;
      readonly channel: Channel;
    }) {
      if (released) return;
      const record: RuntimeConnection = {
        url: connection.url,
        token: connection.token,
        pid: process.pid,
        rpcVersion: connection.rpcVersion,
        version: device.version,
        channel: connection.channel,
        dataDirectory: directory,
      };
      writeSecretFile(connectionFile, connectionPending, JSON.stringify(record));
    },
    clearConnection() {
      rmSync(connectionFile, { force: true });
      rmSync(connectionPending, { force: true });
    },
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(file, { force: true });
        rmSync(pending, { force: true });
        rmSync(connectionFile, { force: true });
        rmSync(connectionPending, { force: true });
      } finally {
        lock.close();
      }
    },
  };
};
