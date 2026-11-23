import { acquireDaemonLock, isDaemonRunning } from "@cerium/backend/runtime";
import { RPC_VERSION } from "@cerium/rpc";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { vi } from "vite-plus/test";

class FakeUtilityProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Array<unknown> = [];
  killed = false;
  postMessage(message: unknown) {
    this.sent.push(message);
    if (message === "stop") {
      this.stdout.end();
      this.stderr.end();
      queueMicrotask(() => this.emit("exit", 0));
    }
  }
  kill() {
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 1);
  }
}

const fake = vi.hoisted(() => ({
  userData: "",
  logs: "",
  children: [] as Array<FakeUtilityProcess>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "logs" ? fake.logs : fake.userData),
    getAppPath: () => fake.userData,
    getVersion: () => "1.0.0",
  },
  utilityProcess: {
    fork: () => {
      const child = new FakeUtilityProcess();
      fake.children.push(child);
      return child;
    },
  },
}));

vi.mock("../src/crashReports.ts", () => ({ reportCrash: () => undefined }));
vi.mock("../src/updater.ts", () => ({ buildChannel: () => "stable" }));
vi.mock("../src/vault.ts", () => ({
  isVaultRequest: () => false,
  answerVault: async () => undefined,
}));

const { startBackend } = await import("../src/backend.ts");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const textFrame = (payload: string): Buffer => {
  const data = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from([0x81, data.length]), data]);
};

const startMockRpcServer = async (token: string) => {
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
    const accept = createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk) => {
      if ((chunk[0]! & 0x0f) === 0x8) {
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

const noUpdate = () =>
  ({
    version: "1.0.0",
    channel: "stable",
    buildChannel: "stable",
    autoDownload: false,
    manual: false,
    restart: "idle",
    status: { kind: "unsupported" },
  }) as const;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cerium-desktop-backend-"));
  fake.userData = join(root, "userData");
  fake.logs = join(root, "logs");
  fake.children = [];
  mkdirSync(fake.userData, { recursive: true });
  mkdirSync(fake.logs, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startBackend attach-first discovery", () => {
  it("spawns Electron's utilityProcess for desktop-only users when no host is running", async () => {
    const emptyHostDir = join(root, "empty-host");
    const controller = await startBackend(
      { ...process.env, CERIUM_HOST_DATA_DIR: emptyHostDir },
      noUpdate,
      // Guard against a real host service installed on the test machine.
      { disableAttach: true },
    );
    try {
      expect(controller.attached()).toBe(false);
      expect(fake.children).toHaveLength(1);
      const child = fake.children[0]!;
      child.emit("message", { url: "ws://127.0.0.1:50000/rpc", token: "desktop-token" });
      expect(await controller.connection()).toEqual({
        url: "ws://127.0.0.1:50000/rpc",
        token: "desktop-token",
      });
      await controller.stop();
      expect(child.sent).toContain("stop");
    } finally {
      await controller.stop();
    }
  });

  it("attaches to a live cerium-host without spawning a duplicate utilityProcess and detaches cleanly on stop", async () => {
    const hostDir = join(root, "host");
    const server = await startMockRpcServer("host-token");
    const lock = acquireDaemonLock(hostDir, { name: "Workstation", version: "1.0.0" });
    try {
      lock.publishConnection({
        url: server.url,
        token: "host-token",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });

      const controller = await startBackend({ ...process.env, CERIUM_HOST_DATA_DIR: hostDir }, noUpdate);
      expect(controller.attached()).toBe(true);
      expect(fake.children).toHaveLength(0);
      expect(await controller.connection()).toEqual({ url: server.url, token: "host-token" });

      // Quitting desktop detaches cleanly and leaves cerium-host untouched.
      await controller.stop();
      expect(isDaemonRunning(hostDir)).toBe(true);
      expect(fake.children).toHaveLength(0);
    } finally {
      lock.release();
      await server.close();
    }
  });

  it("allows explicit opt-in useLocalBackend() fallback without ever doing so silently", async () => {
    const hostDir = join(root, "host-stopped");
    const server = await startMockRpcServer("host-token");
    const lock = acquireDaemonLock(hostDir, { name: "Workstation", version: "1.0.0" });
    try {
      // Simulate a live host whose rpc socket is unreachable so attach mode engages without silent fallback.
      lock.publishConnection({
        url: server.url,
        token: "wrong-token-so-unreachable",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      const controller = await startBackend({ ...process.env, CERIUM_HOST_DATA_DIR: hostDir }, noUpdate);
      try {
        expect(controller.attached()).toBe(true);
        expect(controller.failure()?.kind).toBe("hostUnreachable");
        expect(fake.children).toHaveLength(0);

        const changes: Array<boolean> = [];
        controller.onAttachedChange((attached) => changes.push(attached));

        controller.useLocalBackend();
        expect(controller.attached()).toBe(false);
        expect(changes).toEqual([false]);
        expect(controller.failure()).toBeUndefined();
        expect(fake.children).toHaveLength(1);
        fake.children[0]!.emit("message", { url: "ws://127.0.0.1:50001/rpc", token: "fallback-token" });
        expect(await controller.connection()).toEqual({
          url: "ws://127.0.0.1:50001/rpc",
          token: "fallback-token",
        });
      } finally {
        await controller.stop();
      }
    } finally {
      lock.release();
      await server.close();
    }
  });

  it("skips attach during smoke tests even when a live cerium-host exists", async () => {
    const hostDir = join(root, "host-smoke");
    const server = await startMockRpcServer("host-token");
    const lock = acquireDaemonLock(hostDir, { name: "Workstation", version: "1.0.0" });
    try {
      lock.publishConnection({
        url: server.url,
        token: "host-token",
        rpcVersion: RPC_VERSION,
        channel: "stable",
      });
      writeFileSync(join(hostDir, "marker"), "keep");
      const controller = await startBackend({ ...process.env, CERIUM_HOST_DATA_DIR: hostDir }, noUpdate, {
        disableAttach: true,
      });
      try {
        expect(controller.attached()).toBe(false);
        expect(fake.children).toHaveLength(1);
      } finally {
        await controller.stop();
      }
    } finally {
      lock.release();
      await server.close();
    }
  });
});
