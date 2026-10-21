import { app, safeStorage } from "electron";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// This machine's Cerium sign-in, kept for the backend (apps/backend/src/vault.ts): encrypted with
// Windows' data protection, so only this Windows account can read it, or on Linux with a key from the
// desktop's keyring (GNOME Keyring, KWallet). The backend asks for it over its parent port; nothing
// else can.

interface VaultRequest {
  readonly type: "vault";
  readonly id: string;
  readonly op: "read" | "write";
  readonly value?: string | null;
}

export const isVaultRequest = (message: unknown): message is VaultRequest =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "vault" &&
  typeof (message as { id?: unknown }).id === "string" &&
  ((message as { op?: unknown }).op === "read" || (message as { op?: unknown }).op === "write");

const vaultFile = () => join(app.getPath("userData"), "account.bin");

const missing = (error: unknown) => (error as { code?: unknown }).code === "ENOENT";

const read = async (): Promise<string | null> => {
  try {
    return safeStorage.decryptString(await readFile(vaultFile()));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};

const write = async (value: string | null) => {
  if (value === null) return rm(vaultFile(), { force: true });
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      process.platform === "win32"
        ? "Windows can't protect Cerium's sign-in on this PC, so it wasn't saved."
        : "No keyring can protect Cerium's sign-in on this computer, so it wasn't saved.",
    );
  }
  // Written beside it and moved into place, so a crash never leaves half a sign-in. Only this user
  // may read it: without a keyring, Linux encrypts it with a key every app knows.
  const next = `${vaultFile()}.next`;
  await writeFile(next, safeStorage.encryptString(value), { mode: 0o600 });
  await rename(next, vaultFile());
};

/** Answers one of the backend's requests; failures come back as a message for the user. */
export const answerVault = async (request: VaultRequest) => {
  try {
    if (request.op === "read") return { type: "vault", id: request.id, value: await read() };
    await write(typeof request.value === "string" ? request.value : null);
    return { type: "vault", id: request.id };
  } catch (error) {
    return {
      type: "vault",
      id: request.id,
      error: error instanceof Error ? error.message : "Cerium couldn't reach this machine's sign-in.",
    };
  }
};
