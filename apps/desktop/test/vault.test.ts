import { beforeEach, describe, expect, it } from "@effect/vitest";
import { join } from "node:path";
import { vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({
  available: vi.fn<() => Promise<boolean>>(),
  encrypt: vi.fn<(value: string) => Promise<Buffer>>(),
  decrypt: vi.fn<(value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
  macDeveloperId: vi.fn<() => Promise<boolean>>(),
  chmod: vi.fn<(path: string, mode: number) => Promise<void>>(),
  files: new Map<string, Buffer>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "vault" },
  safeStorage: {
    isAsyncEncryptionAvailable: storage.available,
    encryptStringAsync: storage.encrypt,
    decryptStringAsync: storage.decrypt,
  },
}));

vi.mock("../src/macUpdates.ts", () => ({
  hasDeveloperIdSignature: storage.macDeveloperId,
}));

vi.mock("node:fs/promises", () => ({
  readFile: async (path: string, encoding?: BufferEncoding) => {
    const value = storage.files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return encoding ? value.toString(encoding) : value;
  },
  writeFile: async (path: string, value: Buffer | string) => {
    storage.files.set(path, typeof value === "string" ? Buffer.from(value, "utf8") : value);
  },
  chmod: storage.chmod,
  rename: async (from: string, to: string) => {
    storage.files.set(to, storage.files.get(from)!);
    storage.files.delete(from);
  },
  rm: async (path: string) => {
    storage.files.delete(path);
  },
}));

import { answerVault, createVault } from "../src/vault.ts";

const withPlatform = async (platformName: NodeJS.Platform, run: () => Promise<void>) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platformName });
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
};

describe("the desktop vault", () => {
  beforeEach(() => {
    storage.files.clear();
    storage.available.mockReset().mockResolvedValue(true);
    storage.macDeveloperId.mockReset().mockResolvedValue(true);
    storage.chmod.mockReset().mockResolvedValue(undefined);
    storage.encrypt
      .mockReset()
      .mockImplementation(async (value: string) => Buffer.from(`encrypted:${value}`));
    storage.decrypt.mockReset().mockImplementation(async (value: Buffer) => ({
      result: value.toString().slice(10),
      shouldReEncrypt: false,
    }));
  });

  it("keeps account and router secrets separate through reads and deletion", async () => {
    await answerVault({ type: "vault", id: "1", op: "write", value: "account" });
    await answerVault({ type: "vault", id: "2", op: "write", name: "effortRouter", value: "router" });
    expect(await answerVault({ type: "vault", id: "3", op: "read" })).toMatchObject({
      value: "account",
    });
    expect(await answerVault({ type: "vault", id: "4", op: "read", name: "effortRouter" })).toMatchObject({
      value: "router",
    });
    await answerVault({ type: "vault", id: "5", op: "write", value: null });
    expect(await answerVault({ type: "vault", id: "6", op: "read" })).toMatchObject({
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
    await withPlatform("linux", async () => {
      const vault = createVault(storage.macDeveloperId);
      storage.encrypt.mockResolvedValueOnce(Buffer.from("v10insecure"));
      expect(await vault({ type: "vault", id: "1", op: "write", value: "secret" })).toHaveProperty("error");
      expect(storage.files.size).toBe(0);
      storage.encrypt.mockResolvedValueOnce(Buffer.from("v11protected"));
      expect(await vault({ type: "vault", id: "2", op: "write", value: "secret" })).not.toHaveProperty(
        "error",
      );
      expect(storage.macDeveloperId).not.toHaveBeenCalled();
    });
  });

  it("uses private plain files instead of Keychain on ad hoc macOS builds", async () => {
    await withPlatform("darwin", async () => {
      storage.macDeveloperId.mockResolvedValue(false);
      storage.files.set(join("vault", "account.bin"), Buffer.from("encrypted:stale"));
      const vault = createVault(storage.macDeveloperId);

      // Never touches Keychain even when an older encrypted file sits on disk.
      expect(await vault({ type: "vault", id: "1", op: "read" })).toMatchObject({ value: null });
      expect(storage.decrypt).not.toHaveBeenCalled();

      // Writing saves account.json and cleans up the stale encrypted file.
      expect(await vault({ type: "vault", id: "2", op: "write", value: "account" })).not.toHaveProperty(
        "error",
      );
      expect(storage.files.get(join("vault", "account.json"))?.toString("utf8")).toBe("account");
      expect(storage.files.has(join("vault", "account.bin"))).toBe(false);
      expect(storage.chmod).toHaveBeenCalledWith(join("vault", "account.json.next"), 0o600);
      expect(storage.encrypt).not.toHaveBeenCalled();

      // Reading returns the saved secret without calling safeStorage, and caches the signature check.
      expect(await vault({ type: "vault", id: "3", op: "read" })).toMatchObject({ value: "account" });
      expect(storage.macDeveloperId).toHaveBeenCalledTimes(1);

      // Deleting removes both plain and encrypted files.
      storage.files.set(join("vault", "account.bin"), Buffer.from("encrypted:leftover"));
      expect(await vault({ type: "vault", id: "4", op: "write", value: null })).not.toHaveProperty("error");
      expect(storage.files.has(join("vault", "account.json"))).toBe(false);
      expect(storage.files.has(join("vault", "account.bin"))).toBe(false);
    });
  });

  it("migrates plain macOS secrets into Keychain when upgrading to a Developer ID build", async () => {
    await withPlatform("darwin", async () => {
      storage.macDeveloperId.mockResolvedValue(true);
      storage.files.set(join("vault", "account.json"), Buffer.from("migrated-account", "utf8"));
      const vault = createVault(storage.macDeveloperId);

      expect(await vault({ type: "vault", id: "1", op: "read" })).toMatchObject({
        value: "migrated-account",
      });
      expect(storage.encrypt).toHaveBeenCalledWith("migrated-account");
      expect(storage.files.has(join("vault", "account.bin"))).toBe(true);
      expect(storage.files.has(join("vault", "account.json"))).toBe(false);
      expect(await vault({ type: "vault", id: "2", op: "read" })).toMatchObject({
        value: "migrated-account",
      });
      expect(storage.decrypt).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the plain macOS secret if Keychain is unavailable during Developer ID migration", async () => {
    await withPlatform("darwin", async () => {
      storage.macDeveloperId.mockResolvedValue(true);
      storage.available.mockResolvedValueOnce(false);
      storage.files.set(join("vault", "account.json"), Buffer.from("keep-me", "utf8"));
      const vault = createVault(storage.macDeveloperId);

      expect(await vault({ type: "vault", id: "1", op: "read" })).toMatchObject({ value: "keep-me" });
      expect(storage.files.has(join("vault", "account.json"))).toBe(true);
      expect(storage.files.has(join("vault", "account.bin"))).toBe(false);
    });
  });
});
