import { app, safeStorage } from "electron";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The secrets Cerium keeps for the backend (apps/backend/src/vault.ts): this machine's Cerium sign-in,
// and the OpenRouter key the user gave the effort router. Each is encrypted with Windows' data
// protection, so only this Windows account can read it, on macOS with a key from the user's Keychain,
// or on Linux with a key from the desktop's keyring (GNOME Keyring, KWallet). The backend asks for
// them over its parent port; nothing else can.

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

const vaultFile = (name: SecretName | undefined) =>
  join(app.getPath("userData"), name === "effortRouter" ? "effort-router.bin" : "account.bin");

/** What the secret is, in the messages the user reads. */
const subject = (name: SecretName | undefined) =>
  name === "effortRouter" ? "the effort router's key" : "Cerium's sign-in";

const missing = (error: unknown) => (error as { code?: unknown }).code === "ENOENT";

const read = async (name: SecretName | undefined): Promise<string | null> => {
  try {
    return safeStorage.decryptString(await readFile(vaultFile(name)));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};

const write = async (name: SecretName | undefined, value: string | null) => {
  if (value === null) return rm(vaultFile(name), { force: true });
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      process.platform === "win32"
        ? `Windows can't protect ${subject(name)} on this PC, so it wasn't saved.`
        : process.platform === "darwin"
          ? `Your Keychain can't protect ${subject(name)} on this Mac, so it wasn't saved.`
          : `No keyring can protect ${subject(name)} on this computer, so it wasn't saved.`,
    );
  }
  // Written beside it and moved into place, so a crash never leaves half a secret. Only this user
  // may read it: without a keyring, Linux encrypts it with a key every app knows.
  const next = `${vaultFile(name)}.next`;
  await writeFile(next, safeStorage.encryptString(value), { mode: 0o600 });
  await rename(next, vaultFile(name));
};

/** Answers one of the backend's requests; failures come back as a message for the user. */
export const answerVault = async (request: VaultRequest) => {
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
