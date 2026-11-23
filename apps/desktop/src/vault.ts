import { app, safeStorage } from "electron";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { hasDeveloperIdSignature } from "./macUpdates.ts";

// The secrets Cerium keeps for the backend (apps/backend/src/vault.ts): this machine's Cerium sign-in,
// and the OpenRouter key the user gave the effort router. Each is encrypted with Windows' data
// protection, so only this Windows account can read it, on macOS with a key from the user's Keychain
// (or a private file on ad hoc builds, whose code hash changes on every update), or on Linux with a
// key from the desktop's keyring (GNOME Keyring, KWallet). The backend asks for them over its parent
// port; nothing else can.

/** Which secret: absent for the sign-in, which requests from before there were others name. */
type SecretName = "effortRouter";

interface VaultRequest {
  readonly type: "vault";
  readonly id: string;
  readonly op: "read" | "write";
  readonly name?: SecretName;
  readonly value?: string | null;
}

export const isVaultRequest = (message: unknown): message is VaultRequest =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "vault" &&
  typeof (message as { id?: unknown }).id === "string" &&
  ((message as { op?: unknown }).op === "read" || (message as { op?: unknown }).op === "write") &&
  ((message as { name?: unknown }).name === undefined ||
    (message as { name?: unknown }).name === "effortRouter");

const encryptedFile = (name: SecretName | undefined) =>
  join(app.getPath("userData"), name === "effortRouter" ? "effort-router.bin" : "account.bin");

const plainFile = (name: SecretName | undefined) =>
  join(app.getPath("userData"), name === "effortRouter" ? "effort-router.json" : "account.json");

/** What the secret is, in the messages the user reads. */
const subject = (name: SecretName | undefined) =>
  name === "effortRouter" ? "the effort router's key" : "Cerium's sign-in";

const missing = (error: unknown) => (error as { code?: unknown }).code === "ENOENT";

const unavailable = (name: SecretName | undefined) =>
  new Error(
    process.platform === "win32"
      ? `Windows can't protect ${subject(name)} on this PC, so it wasn't saved.`
      : process.platform === "darwin"
        ? `Your Keychain can't protect ${subject(name)} on this Mac, so it wasn't saved.`
        : `No keyring can protect ${subject(name)} on this computer, so it wasn't saved.`,
  );

const readPlain = async (name: SecretName | undefined): Promise<string | null> => {
  const file = plainFile(name);
  try {
    const value = await readFile(file, "utf8");
    await chmod(file, 0o600).catch(() => undefined);
    return value;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};

const writePlain = async (name: SecretName | undefined, value: string) => {
  const file = plainFile(name);
  const next = `${file}.next`;
  try {
    await writeFile(next, value, { mode: 0o600 });
    await chmod(next, 0o600);
    await rename(next, file);
  } catch (error) {
    await rm(next, { force: true }).catch(() => undefined);
    throw error;
  }
};

const writeEncrypted = async (name: SecretName | undefined, value: string) => {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw unavailable(name);
  const encrypted = await safeStorage.encryptStringAsync(value);
  // Electron 44 reports async initialization as available even when Linux uses its known v10 key.
  if (process.platform === "linux" && encrypted.subarray(0, 3).toString() === "v10") throw unavailable(name);
  // Written beside it and moved into place, so a crash never leaves half a secret. Only this user
  // may read it: without a keyring, Linux encrypts it with a key every app knows.
  const file = encryptedFile(name);
  const next = `${file}.next`;
  try {
    await writeFile(next, encrypted, { mode: 0o600 });
    await rename(next, file);
  } catch (error) {
    await rm(next, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const createVault = (checkMacDeveloperId: () => Promise<boolean> = hasDeveloperIdSignature) => {
  let macDeveloperId: Promise<boolean> | undefined;
  const usePlainMacFile = async (): Promise<boolean> => {
    if (process.platform !== "darwin") return false;
    macDeveloperId ??= checkMacDeveloperId();
    return !(await macDeveloperId);
  };

  const read = async (name: SecretName | undefined): Promise<string | null> => {
    if (await usePlainMacFile()) return readPlain(name);
    let encrypted: Buffer;
    try {
      encrypted = await readFile(encryptedFile(name));
    } catch (error) {
      if (!missing(error)) throw error;
      if (process.platform !== "darwin") return null;
      const migrated = await readPlain(name);
      if (migrated === null) return null;
      try {
        await writeEncrypted(name, migrated);
        await rm(plainFile(name), { force: true });
      } catch {
        // Keep the plain file so a later launch can still read and upgrade it.
      }
      return migrated;
    }
    return (await safeStorage.decryptStringAsync(encrypted)).result;
  };

  const write = async (name: SecretName | undefined, value: string | null) => {
    if (value === null) {
      await rm(encryptedFile(name), { force: true });
      if (process.platform === "darwin") await rm(plainFile(name), { force: true });
      return;
    }
    if (await usePlainMacFile()) {
      await writePlain(name, value);
      await rm(encryptedFile(name), { force: true });
      return;
    }
    await writeEncrypted(name, value);
    if (process.platform === "darwin") await rm(plainFile(name), { force: true });
  };

  /** Answers one of the backend's requests; failures come back as a message for the user. */
  return async (request: VaultRequest) => {
    try {
      if (request.op === "read") return { type: "vault", id: request.id, value: await read(request.name) };
      await write(request.name, typeof request.value === "string" ? request.value : null);
      return { type: "vault", id: request.id };
    } catch (error) {
      return {
        type: "vault",
        id: request.id,
        error: error instanceof Error ? error.message : `Cerium couldn't reach ${subject(request.name)}.`,
      };
    }
  };
};

/** Answers one of the backend's requests; failures come back as a message for the user. */
export const answerVault = createVault();
