import type { AccountState } from "@cerium/protocol";
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

const busy = (error: unknown) =>
  typeof error === "object" && error !== null && "errcode" in error && error.errcode === 5; // SQLITE_BUSY

/** Only a process holding the OS lock for this directory can publish live status. */
export const readRuntimeStatus = (directory: string): RuntimeStatus | undefined => {
  const lockfile = join(directory, "daemon.lock");
  if (!existsSync(lockfile)) return undefined;
  using lock = new DatabaseSync(lockfile, { readOnly: true });
  try {
    lock.prepare("SELECT name FROM sqlite_schema").all();
    return undefined;
  } catch (error) {
    if (!busy(error)) throw error;
  }
  try {
    return Option.getOrUndefined(decodeStatus(readFileSync(join(directory, "runtime.json"), "utf8")));
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

/** Publish live status until this daemon releases ownership of its data directory. */
export const acquireDaemonLock = (directory: string, device: { name: string; version: string }) => {
  const lock = lockDirectory(directory, true);
  const file = join(directory, "runtime.json");
  const pending = file + ".tmp";
  const base = { pid: process.pid, startedAt: Date.now(), name: device.name, version: device.version };
  let released = false;
  let previous: string | undefined;
  const write = (state: Pick<RuntimeStatus, "connection" | "deviceId">) => {
    const contents = JSON.stringify({ ...base, ...state });
    if (released || contents === previous) return;
    writeFileSync(pending, contents, { mode: 0o600 });
    renameSync(pending, file);
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
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(file, { force: true });
        rmSync(pending, { force: true });
      } finally {
        lock.close();
      }
    },
  };
};
