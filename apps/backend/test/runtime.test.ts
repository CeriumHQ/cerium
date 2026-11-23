import type { AccountId, DeviceId } from "@cerium/protocol";
import { assert, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireDaemonLock,
  acquireDataLock,
  isDaemonRunning,
  readRuntimeConnection,
  readRuntimeStatus,
} from "../src/runtime.ts";

const device = { name: "Lab", version: "1.0" };

it("publishes account state and 0o600 connection handoff while holding the lock and removes both on shutdown", () => {
  const directory = mkdtempSync(join(tmpdir(), "cerium-runtime-"));
  try {
    assert.isFalse(isDaemonRunning(directory));
    assert.isUndefined(readRuntimeStatus(directory));
    assert.isUndefined(readRuntimeConnection(directory));
    const lock = acquireDaemonLock(directory, device);
    try {
      assert.isTrue(isDaemonRunning(directory));
      const startup = readRuntimeStatus(directory);
      assert.isDefined(startup);
      assert.include(startup, { ...device, pid: process.pid, connection: "starting" });
      assert.throws(() => acquireDaemonLock(directory, device), "already running");
      lock.publishConnection({
        url: "ws://127.0.0.1:41234/rpc",
        token: "secret-handoff-token",
        rpcVersion: 58,
        channel: "stable",
      });
      if (process.platform !== "win32") {
        assert.equal(statSync(join(directory, "connection.json")).mode & 0o777, 0o600);
      }
      assert.deepEqual(readRuntimeConnection(directory), {
        url: "ws://127.0.0.1:41234/rpc",
        token: "secret-handoff-token",
        pid: process.pid,
        rpcVersion: 58,
        version: device.version,
        channel: "stable",
        dataDirectory: directory,
      });
      // Runtime status stays strictly separate from the secret connection token.
      assert.notInclude(readFileSync(join(directory, "runtime.json"), "utf8"), "secret-handoff-token");
      assert.notInclude(JSON.stringify(readRuntimeStatus(directory)), "secret-handoff-token");

      lock.update({
        _tag: "SignedIn",
        account: { id: "acc_1" as AccountId },
        deviceId: "dev_1" as DeviceId,
        devices: [],
        connection: "online",
      });
      assert.deepEqual(readRuntimeStatus(directory), { ...startup, deviceId: "dev_1", connection: "online" });
      lock.update({ _tag: "SignedOut" });
      assert.deepEqual(readRuntimeStatus(directory), { ...startup, connection: "signed-out" });

      // Non-loopback URLs or empty tokens are rejected when reading connection.json.
      writeFileSync(
        join(directory, "connection.json"),
        JSON.stringify({
          url: "ws://192.168.1.50:41234/rpc",
          token: "secret-handoff-token",
          pid: process.pid,
          rpcVersion: 58,
          version: device.version,
          channel: "stable",
          dataDirectory: directory,
        }),
      );
      assert.isUndefined(readRuntimeConnection(directory));

      lock.clearConnection();
      assert.isFalse(existsSync(join(directory, "connection.json")));
      assert.isUndefined(readRuntimeConnection(directory));

      lock.publishConnection({
        url: "ws://127.0.0.1:41234/rpc",
        token: "secret-handoff-token",
        rpcVersion: 58,
        channel: "stable",
      });
    } finally {
      lock.release();
    }
    assert.isFalse(isDaemonRunning(directory));
    assert.isFalse(existsSync(join(directory, "runtime.json")));
    assert.isFalse(existsSync(join(directory, "connection.json")));
    const next = acquireDaemonLock(directory, device);
    lock.release();
    assert.isDefined(readRuntimeStatus(directory));
    next.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("ignores stale status and connection after a process dies and immediately allows a new owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cerium-runtime-crash-"));
  const script = `
    import { acquireDaemonLock } from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url))};
    globalThis.lock = acquireDaemonLock(process.argv[1], { name: "Lab", version: "1.0" });
    globalThis.lock.publishConnection({
      url: "ws://127.0.0.1:41234/rpc",
      token: "crashed-secret-token",
      rpcVersion: 58,
      channel: "stable",
    });
    process.send("locked");
    setInterval(() => {}, 60000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script, directory], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error("Lock owner exited before startup");
      }),
    ]);
    assert.isTrue(isDaemonRunning(directory));
    assert.isDefined(readRuntimeConnection(directory));
    assert.throws(() => acquireDaemonLock(directory, device), "already running");
    assert.throws(() => acquireDataLock(directory), "already running");
    child.kill("SIGKILL");
    await exited;
    assert.isTrue(existsSync(join(directory, "runtime.json")));
    assert.isTrue(existsSync(join(directory, "connection.json")));
    assert.isFalse(isDaemonRunning(directory));
    assert.isUndefined(readRuntimeStatus(directory));
    assert.isUndefined(readRuntimeConnection(directory));
    const account = acquireDataLock(directory);
    try {
      assert.isUndefined(readRuntimeStatus(directory));
      assert.isUndefined(readRuntimeConnection(directory));
      assert.isFalse(existsSync(join(directory, "runtime.json")));
      assert.isFalse(existsSync(join(directory, "connection.json")));
      assert.throws(() => acquireDaemonLock(directory, device), "already running");
      assert.throws(() => acquireDataLock(directory), "already running");
    } finally {
      account.release();
    }
    const next = acquireDaemonLock(directory, device);
    account.release();
    assert.isDefined(readRuntimeStatus(directory));
    next.release();
  } finally {
    child.kill();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
