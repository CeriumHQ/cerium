import type { AccountId, DeviceId } from "@cerium/protocol";
import { assert, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireDaemonLock, acquireDataLock, readRuntimeStatus } from "../src/runtime.ts";

const device = { name: "Lab", version: "1.0" };

it("publishes account state while holding the lock and removes it on shutdown", () => {
  const directory = mkdtempSync(join(tmpdir(), "cerium-runtime-"));
  try {
    assert.isUndefined(readRuntimeStatus(directory));
    const lock = acquireDaemonLock(directory, device);
    try {
      const startup = readRuntimeStatus(directory);
      assert.isDefined(startup);
      assert.include(startup, { ...device, pid: process.pid, connection: "starting" });
      assert.throws(() => acquireDaemonLock(directory, device), "already running");
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
    } finally {
      lock.release();
    }
    assert.isFalse(existsSync(join(directory, "runtime.json")));
    const next = acquireDaemonLock(directory, device);
    lock.release();
    assert.isDefined(readRuntimeStatus(directory));
    next.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("ignores stale status after a process dies and immediately allows a new owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cerium-runtime-crash-"));
  const script = `
    import { acquireDaemonLock } from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url))};
    globalThis.lock = acquireDaemonLock(process.argv[1], { name: "Lab", version: "1.0" });
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
    assert.throws(() => acquireDaemonLock(directory, device), "already running");
    assert.throws(() => acquireDataLock(directory), "already running");
    child.kill("SIGKILL");
    await exited;
    assert.isTrue(existsSync(join(directory, "runtime.json")));
    assert.isUndefined(readRuntimeStatus(directory));
    const account = acquireDataLock(directory);
    try {
      assert.isUndefined(readRuntimeStatus(directory));
      assert.isFalse(existsSync(join(directory, "runtime.json")));
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
