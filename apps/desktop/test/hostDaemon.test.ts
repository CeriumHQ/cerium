import { acquireDaemonLock, isDaemonRunning, readRuntimeConnection } from "@cerium/backend/runtime";
import { RPC_VERSION } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAttachedBackend } from "../src/attachedBackend.ts";
import type { BackendFailure } from "../src/backendFailure.ts";
import {
  checkRpcCompatibility,
  discoverHostDaemon,
  findHostUpdaterCommand,
  inspectHostService,
  parseLaunchdService,
  parseSystemdService,
  parseWindowsService,
  probeRpcEndpoint,
  type HostServiceInfo,
} from "../src/hostDaemon.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const textFrame = (payload: string): Buffer => {
  const data = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from([0x81, data.length]), data]);
};

/** Minimal loopback WebSocket server enforcing `?token=` and replying with an RPC Pong frame. */
const startMockRpcServer = async (
  token: string,
): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> => {
  const sockets = new Set<import("node:stream").Duplex>();
  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname !== "/rpc" || parsed.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk) => {
      const opcode = chunk[0]! & 0x0f;
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      socket.write(textFrame('{"_tag":"Pong"}'));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
};

const makeService = (directory: string, installed: boolean): HostServiceInfo => ({
  installed,
  dataDirectory: directory,
  candidateDirectories: [directory],
});

describe("native service config parsing", () => {
  it("parses systemd ExecStart data-dir and launcher with escaped characters", () => {
    const unit = `[Service]
ExecStart="/opt/cerium host/bin/node" "/opt/cerium host/bin/standalone.mjs" "run" "--data-dir=/var/lib/cerium 50%% $$HOME" "--channel=stable"
`;
    expect(parseSystemdService(unit)).toEqual({
      dataDirectory: resolve("/var/lib/cerium 50% $HOME"),
      launcher: ["/opt/cerium host/bin/node", "/opt/cerium host/bin/standalone.mjs"],
    });
  });

  it("parses launchd ProgramArguments data-dir and launcher with XML entities", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>app.cerium.host</string>
<key>ProgramArguments</key><array><string>/Users/a/node</string><string>/Users/a/standalone.mjs</string><string>run</string><string>--data-dir=/Users/a/A&amp;B</string></array>
</dict></plist>`;
    expect(parseLaunchdService(plist)).toEqual({
      dataDirectory: resolve("/Users/a/A&B"),
      launcher: ["/Users/a/node", "/Users/a/standalone.mjs"],
    });
  });

  it("parses Windows VBS launcher command", () => {
    const vbs = `Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("PROCESS")
env("CERIUM_HOST_SERVICE_COMMAND") = """C:\\Cerium Host\\node.exe"" ""C:\\Cerium Host\\standalone.mjs"" ""run"" ""--data-dir=C:\\Data\\cerium"""
`;
    expect(parseWindowsService(vbs)).toEqual({
      dataDirectory: resolve("C:\\Data\\cerium"),
      launcher: ["C:\\Cerium Host\\node.exe", "C:\\Cerium Host\\standalone.mjs"],
    });
  });

  it("inspects installed services and honors CERIUM_HOST_DATA_DIR override", () => {
    const home = mkdtempSync(join(tmpdir(), "cerium-home-"));
    try {
      const plistDir = join(home, "Library", "LaunchAgents");
      mkdirSync(plistDir, { recursive: true });
      const customDir = join(home, "custom-host-data");
      writeFileSync(
        join(plistDir, "app.cerium.host.plist"),
        `<plist><dict><key>ProgramArguments</key><array><string>/bin/node</string><string>/bin/standalone.mjs</string><string>run</string><string>--data-dir=${customDir}</string></array></dict></plist>`,
      );
      const darwin = inspectHostService({ platform: "darwin", home, env: {} });
      expect(darwin.installed).toBe(true);
      expect(darwin.dataDirectory).toBe(resolve(customDir));
      expect(darwin.candidateDirectories).toEqual([resolve(customDir), resolve(join(home, ".cerium"))]);
      expect(darwin.launcher).toEqual(["/bin/node", "/bin/standalone.mjs"]);

      const overrideDir = join(home, "override-data");
      const overridden = inspectHostService({
        platform: "darwin",
        home,
        env: { CERIUM_HOST_DATA_DIR: overrideDir },
      });
      expect(overridden.dataDirectory).toBe(resolve(overrideDir));
      expect(overridden.candidateDirectories).toEqual([resolve(overrideDir)]);

      const absent = inspectHostService({ platform: "linux", home, env: {} });
      expect(absent.installed).toBe(false);
      expect(absent.dataDirectory).toBe(resolve(join(home, ".cerium")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers service launcher, then standalone install root, then PATH for host updates", () => {
    const home = "/fake/home";
    const service: HostServiceInfo = {
      installed: true,
      dataDirectory: "/fake/data",
      candidateDirectories: ["/fake/data"],
      launcher: ["/svc/node", "/svc/standalone.mjs"],
    };
    expect(
      findHostUpdaterCommand(service, {
        platform: "darwin",
        home,
        env: {},
        exists: (path) => path === "/svc/node" || path === "/svc/standalone.mjs",
      }),
    ).toEqual({ command: "/svc/node", args: ["/svc/standalone.mjs"] });

    expect(
      findHostUpdaterCommand(
        { installed: false, dataDirectory: "/fake/data", candidateDirectories: ["/fake/data"] },
        {
          platform: "linux",
          home,
          env: {},
          exists: (path) =>
            path === join(home, ".local", "share", "cerium-host", "runtime", "bin/node") ||
            path === join(home, ".local", "share", "cerium-host", "bin", "standalone.mjs"),
        },
      ),
    ).toEqual({
      command: join(home, ".local", "share", "cerium-host", "runtime", "bin/node"),
      args: [join(home, ".local", "share", "cerium-host", "bin", "standalone.mjs")],
    });

    expect(
      findHostUpdaterCommand(
        { installed: false, dataDirectory: "/fake/data", candidateDirectories: ["/fake/data"] },
        { platform: "darwin", home, env: {}, exists: () => false },
      ),
    ).toEqual({ command: "cerium-host", args: [] });
  });
});

describe("rpcVersion compatibility and discovery", () => {
  it("classifies compatible, older host, and newer host rpcVersions", () => {
    expect(checkRpcCompatibility(RPC_VERSION, RPC_VERSION)).toBe("compatible");
    expect(checkRpcCompatibility(RPC_VERSION - 1, RPC_VERSION)).toBe("hostOutdated");
    expect(checkRpcCompatibility(undefined, RPC_VERSION)).toBe("hostOutdated");
    expect(checkRpcCompatibility(RPC_VERSION + 1, RPC_VERSION)).toBe("desktopOutdated");
  });

  it("probes live local RPC endpoints and rejects invalid tokens", async () => {
    const server = await startMockRpcServer("valid-token");
    try {
      expect(await probeRpcEndpoint(server.url, "valid-token", 2_000)).toBe(true);
      expect(await probeRpcEndpoint(server.url, "wrong-token", 2_000)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns absent for desktop-only users and serviceStopped when service is installed but stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-discover-empty-"));
    try {
      expect(await discoverHostDaemon({ service: makeService(dir, false), startupWaitMs: 0 })).toEqual({
        kind: "absent",
      });
      expect(await discoverHostDaemon({ service: makeService(dir, true), startupWaitMs: 0 })).toEqual({
        kind: "serviceStopped",
        dataDirectory: dir,
        serviceInstalled: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers a live compatible daemon and flags older/newer rpcVersions without falling back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-discover-live-"));
    const server = await startMockRpcServer("live-token");
    const lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.2.3" });
    try {
      // Older daemon that only wrote runtime.json (no connection.json yet).
      const preAttach = await discoverHostDaemon({
        service: makeService(dir, true),
        startupWaitMs: 0,
      });
      expect(preAttach).toMatchObject({
        kind: "incompatible",
        direction: "hostOutdated",
        version: "1.2.3",
        expectedRpcVersion: RPC_VERSION,
      });

      // Older rpcVersion.
      lock.publishConnection({
        url: server.url,
        token: "live-token",
        rpcVersion: RPC_VERSION - 1,
        channel: "stable",
      });
      expect(await discoverHostDaemon({ service: makeService(dir, true), startupWaitMs: 0 })).toMatchObject({
        kind: "incompatible",
        direction: "hostOutdated",
        hostRpcVersion: RPC_VERSION - 1,
        expectedRpcVersion: RPC_VERSION,
      });

      // Newer rpcVersion.
      lock.publishConnection({
        url: server.url,
        token: "live-token",
        rpcVersion: RPC_VERSION + 2,
        channel: "nightly",
      });
      expect(await discoverHostDaemon({ service: makeService(dir, true), startupWaitMs: 0 })).toMatchObject({
        kind: "incompatible",
        direction: "desktopOutdated",
        hostRpcVersion: RPC_VERSION + 2,
        expectedRpcVersion: RPC_VERSION,
      });

      // Compatible rpcVersion + live RPC endpoint.
      lock.publishConnection({
        url: server.url,
        token: "live-token",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      const ready = await discoverHostDaemon({ service: makeService(dir, true), startupWaitMs: 0 });
      expect(ready).toMatchObject({
        kind: "ready",
        serviceInstalled: true,
        connection: {
          url: server.url,
          token: "live-token",
          rpcVersion: RPC_VERSION,
          version: "1.2.3",
          channel: "stable",
          dataDirectory: dir,
        },
      });
    } finally {
      lock.release();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("attached backend lifecycle", () => {
  it("detaches cleanly on stop() without stopping cerium-host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-detach-"));
    const server = await startMockRpcServer("token-1");
    const lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.0" });
    try {
      lock.publishConnection({
        url: server.url,
        token: "token-1",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("ready");
      if (discovery.kind !== "ready") return;

      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 50,
        waitingPollMs: 30,
        onFailure: () => undefined,
      });
      expect(await attached.connection()).toEqual({ url: server.url, token: "token-1" });

      // Quitting desktop calls stop(), which must leave cerium-host running and untouched.
      await attached.stop();
      expect(isDaemonRunning(dir)).toBe(true);
      expect(readRuntimeConnection(dir)?.token).toBe("token-1");
      expect(await probeRpcEndpoint(server.url, "token-1", 2_000)).toBe(true);
    } finally {
      lock.release();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-discovers updated port and token after cerium-host restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-restart-"));
    const server1 = await startMockRpcServer("token-1");
    const server2 = await startMockRpcServer("token-2");
    let lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.0" });
    try {
      lock.publishConnection({
        url: server1.url,
        token: "token-1",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("ready");
      if (discovery.kind !== "ready") return;

      const failures: Array<BackendFailure | undefined> = [];
      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 40,
        waitingPollMs: 30,
        restartGraceMs: 2_000,
        connectTimeoutMs: 3_000,
        onFailure: (next) => failures.push(next),
      });
      try {
        expect(await attached.connection()).toEqual({ url: server1.url, token: "token-1" });

        // Simulate cerium-host shutting down and restarting with a fresh port & token.
        lock.release();
        await server1.close();

        const reconnecting = attached.connection();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));

        lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.1" });
        lock.publishConnection({
          url: server2.url,
          token: "token-2",
          rpcVersion: RPC_VERSION,
          channel: "stable",
        });

        expect(await reconnecting).toEqual({ url: server2.url, token: "token-2" });
        expect(attached.failure()).toBeUndefined();
        expect(failures.every((item) => item === undefined)).toBe(true);
      } finally {
        await attached.stop();
      }
    } finally {
      lock.release();
      await server2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces hostStopped when service is stopped and connects after startHostService()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-stopped-"));
    const server = await startMockRpcServer("started-token");
    let lock: ReturnType<typeof acquireDaemonLock> | undefined;
    try {
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("serviceStopped");
      if (discovery.kind !== "serviceStopped") return;

      const seen: Array<BackendFailure | undefined> = [];
      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 50,
        waitingPollMs: 30,
        actionWaitMs: 2_000,
        startService: async () => {
          lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.0" });
          lock.publishConnection({
            url: server.url,
            token: "started-token",
            rpcVersion: RPC_VERSION,
            channel: "stable",
          });
        },
        onFailure: (next) => seen.push(next),
      });
      try {
        expect(attached.failure()?.kind).toBe("hostStopped");
        expect(attached.failure()?.host?.serviceInstalled).toBe(true);
        expect(attached.failure()?.host?.canFallback).toBe(true);
        await expect(attached.connection()).rejects.toThrow(/Cerium Host service is stopped/i);

        await attached.startHostService();
        expect(attached.failure()).toBeUndefined();
        expect(await attached.connection()).toEqual({ url: server.url, token: "started-token" });
        expect(seen.at(-1)).toBeUndefined();
      } finally {
        await attached.stop();
      }
    } finally {
      lock?.release();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces hostOutdated on rpcVersion mismatch and reconnects once updateHost() upgrades the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-mismatch-"));
    const server1 = await startMockRpcServer("old-token");
    const server2 = await startMockRpcServer("new-token");
    let lock = acquireDaemonLock(dir, { name: "Workstation", version: "0.9.0" });
    try {
      lock.publishConnection({
        url: server1.url,
        token: "old-token",
        rpcVersion: RPC_VERSION - 1,
        channel: "stable",
      });
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("incompatible");
      if (discovery.kind !== "incompatible") return;

      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 50,
        waitingPollMs: 30,
        actionWaitMs: 2_000,
        updateHost: async () => {
          lock.release();
          lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.0" });
          lock.publishConnection({
            url: server2.url,
            token: "new-token",
            rpcVersion: RPC_VERSION,
            channel: "stable",
          });
          return { ok: true, output: "Installed Cerium Host 1.0.0." };
        },
        onFailure: () => undefined,
      });
      try {
        expect(attached.failure()?.kind).toBe("hostOutdated");
        expect(attached.failure()?.host?.command).toBe("cerium-host update");
        await expect(attached.connection()).rejects.toThrow(/cerium-host update/i);

        await attached.updateHost();
        expect(attached.failure()).toBeUndefined();
        expect(await attached.connection()).toEqual({ url: server2.url, token: "new-token" });
      } finally {
        await attached.stop();
      }
    } finally {
      lock.release();
      await server1.close();
      await server2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces desktopOutdated when a restarted daemon upgrades past this desktop's rpcVersion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-newer-"));
    const server1 = await startMockRpcServer("token-1");
    const server2 = await startMockRpcServer("token-2");
    let lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.0" });
    try {
      lock.publishConnection({
        url: server1.url,
        token: "token-1",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("ready");
      if (discovery.kind !== "ready") return;

      const seen: Array<BackendFailure | undefined> = [];
      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 30,
        waitingPollMs: 30,
        onFailure: (next) => seen.push(next),
      });
      try {
        expect(await attached.connection()).toEqual({ url: server1.url, token: "token-1" });

        lock.release();
        await server1.close();
        lock = acquireDaemonLock(dir, { name: "Workstation", version: "2.0.0" });
        lock.publishConnection({
          url: server2.url,
          token: "token-2",
          rpcVersion: RPC_VERSION + 1,
          channel: "stable",
        });

        await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
        expect(attached.failure()?.kind).toBe("desktopOutdated");
        expect(seen.at(-1)?.kind).toBe("desktopOutdated");
        await expect(attached.connection()).rejects.toThrow(/Update Cerium Desktop/i);
      } finally {
        await attached.stop();
      }
    } finally {
      lock.release();
      await server2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces npm update instructions on line 1 when cerium-host update prints multi-line output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-npm-"));
    const server = await startMockRpcServer("old-token");
    const lock = acquireDaemonLock(dir, { name: "Workstation", version: "0.9.0" });
    try {
      lock.publishConnection({
        url: server.url,
        token: "old-token",
        rpcVersion: RPC_VERSION - 1,
        channel: "stable",
      });
      const service = makeService(dir, false);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("incompatible");
      if (discovery.kind !== "incompatible") return;

      const fullOutput = [
        "Cerium Host 0.9.0 → 1.0.0",
        "Install with npm install -g @cerium/host@1.0.0, then restart a running host.",
      ].join("\n");
      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 50,
        waitingPollMs: 30,
        updateHost: async () => ({ ok: true, output: fullOutput }),
        onFailure: () => undefined,
      });
      try {
        await attached.updateHost();
        expect(attached.failure()?.kind).toBe("hostOutdated");
        expect(attached.failure()?.message.split("\n", 1)[0]).toContain("npm install -g @cerium/host@1.0.0");
        expect(attached.failure()?.log).toBe(fullOutput);
      } finally {
        await attached.stop();
      }
    } finally {
      lock.release();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates steady-state failure notifications and preserves pre-attach update errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-dedupe-"));
    const lock = acquireDaemonLock(dir, { name: "Workstation", version: "0.8.0" });
    try {
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("incompatible");
      if (discovery.kind !== "incompatible") return;

      const seen: Array<BackendFailure | undefined> = [];
      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 25,
        waitingPollMs: 25,
        restartGraceMs: 0,
        updateHost: async () => ({
          ok: false,
          output: "Cerium Host 0.8.0 → 1.0.0\nGitHub Releases returned 503.",
        }),
        onFailure: (next) => seen.push(next),
      });
      try {
        // Wait across multiple poll intervals: initial hostOutdated should not spam duplicates.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
        expect(seen).toHaveLength(1);

        await attached.updateHost();
        const afterError = seen.length;
        expect(attached.failure()?.message).toBe("GitHub Releases returned 503.");

        // Subsequent polls must preserve the update failure detail rather than overwriting it.
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 90));
        expect(seen).toHaveLength(afterError);
        expect(attached.failure()?.message).toBe("GitHub Releases returned 503.");
      } finally {
        await attached.stop();
      }
    } finally {
      lock.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects connection() promptly when settled in hostUnreachable without spamming failure events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cerium-attach-unreachable-"));
    const server = await startMockRpcServer("expected-token");
    const lock = acquireDaemonLock(dir, { name: "Workstation", version: "1.0.0" });
    try {
      lock.publishConnection({
        url: server.url,
        token: "wrong-token",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      const service = makeService(dir, true);
      const discovery = await discoverHostDaemon({ service, startupWaitMs: 0 });
      expect(discovery.kind).toBe("unreachable");
      if (discovery.kind !== "unreachable") return;

      const seen: Array<BackendFailure | undefined> = [];
      const attached = createAttachedBackend({
        initial: discovery,
        service,
        getEnv: () => process.env,
        connectedPollMs: 30,
        waitingPollMs: 20,
        restartGraceMs: 0,
        connectTimeoutMs: 5_000,
        onFailure: (next) => seen.push(next),
      });
      try {
        await expect(attached.connection()).rejects.toThrow(/did not respond/i);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        expect(seen).toHaveLength(1);
      } finally {
        await attached.stop();
      }
    } finally {
      lock.release();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
