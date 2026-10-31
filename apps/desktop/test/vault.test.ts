import { beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({
  available: vi.fn<() => Promise<boolean>>(),
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
  decrypt: vi.fn<(value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
  files: new Map<string, Buffer>(),
  writes: [] as Array<{ path: string; mode: number }>,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "vault" },
  safeStorage: {
    isAsyncEncryptionAvailable: storage.available,
    encryptStringAsync: storage.encrypt,
    decryptStringAsync: storage.decrypt,
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => {
    const value = storage.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  },
  writeFile: async (path: string, value: Buffer, options: { mode: number }) => {
    storage.writes.push({ path, mode: options.mode });
    storage.files.set(path, value);
  },
  rename: async (from: string, to: string) => {
    storage.files.set(to, storage.files.get(from)!);
    storage.files.delete(from);
  },
  rm: async (path: string) => {
    storage.files.delete(path);
  },
}));

import { answerVault } from "../src/vault.ts";

describe("the desktop vault", () => {
  beforeEach(() => {
    storage.files.clear();
    storage.writes.length = 0;
    storage.available.mockReset().mockResolvedValue(true);
    storage.encrypt
      .mockReset()
      .mockImplementation(async (value: string) => Buffer.from(`encrypted:${value}`));
    storage.decrypt.mockReset().mockImplementation(async (value: Buffer) => ({
      result: value.toString().slice(10),
      shouldReEncrypt: false,
    }));
  });

  it("writes atomically, reads the async result and keeps the two secrets separate", async () => {
    expect(await answerVault({ type: "vault", id: "1", op: "write", value: "account" })).toEqual({
      type: "vault",
      id: "1",
    });
    await answerVault({ type: "vault", id: "2", op: "write", name: "effortRouter", value: "router" });
    expect(storage.writes.every(({ path, mode }) => path.endsWith(".next") && mode === 0o600)).toBe(true);
    expect(await answerVault({ type: "vault", id: "3", op: "read" })).toEqual({
      type: "vault",
      id: "3",
      value: "account",
    });
    expect(await answerVault({ type: "vault", id: "4", op: "read", name: "effortRouter" })).toEqual({
      type: "vault",
      id: "4",
      value: "router",
    });
    await answerVault({ type: "vault", id: "5", op: "write", value: null });
    expect(await answerVault({ type: "vault", id: "6", op: "read" })).toEqual({
      type: "vault",
      id: "6",
      value: null,
    });
    expect(await answerVault({ type: "vault", id: "7", op: "read", name: "effortRouter" })).toMatchObject({
      value: "router",
    });
  });

  it("does not replace a secret when encryption is unavailable or fails", async () => {
    await answerVault({ type: "vault", id: "1", op: "write", value: "old" });
    storage.available.mockResolvedValueOnce(false);
    expect(await answerVault({ type: "vault", id: "2", op: "write", value: "new" })).toHaveProperty("error");
    storage.encrypt.mockRejectedValueOnce(new Error("keyring failed"));
    expect(await answerVault({ type: "vault", id: "3", op: "write", value: "new" })).toMatchObject({
      error: "keyring failed",
    });
    expect(await answerVault({ type: "vault", id: "4", op: "read" })).toMatchObject({ value: "old" });
  });

  it("refuses Linux's known fallback key even when async encryption reports available", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      storage.encrypt.mockResolvedValueOnce(Buffer.from("v10insecure"));
      expect(await answerVault({ type: "vault", id: "1", op: "write", value: "secret" })).toHaveProperty(
        "error",
      );
      expect(storage.writes).toEqual([]);
      storage.encrypt.mockResolvedValueOnce(Buffer.from("v11protected"));
      expect(await answerVault({ type: "vault", id: "2", op: "write", value: "secret" })).not.toHaveProperty(
        "error",
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
