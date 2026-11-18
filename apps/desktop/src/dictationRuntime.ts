import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface RuntimeManifest {
  readonly version: string;
  readonly onnxVersion: string;
  readonly size: number;
  readonly sha256: string;
}

const versionPattern = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i;

/** The manifest ships beside the UI and describes the exact binary it was built against. */
export const runtimeManifest = (value: unknown, version: string): RuntimeManifest | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const manifest = value as Partial<RuntimeManifest>;
  const { onnxVersion, size, sha256 } = manifest;
  if (
    manifest.version !== version ||
    !versionPattern.test(version) ||
    typeof onnxVersion !== "string" ||
    !versionPattern.test(onnxVersion) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 64 * 1024 * 1024 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    return undefined;
  return { version, onnxVersion, size, sha256 };
};

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Cache by checksum so app updates can share the same verified runtime. */
export const dictationRuntime = (
  cache: string,
  manifest: RuntimeManifest,
  fetchAsset: (url: string, options: RequestInit) => Promise<Response>,
) => {
  const { version, onnxVersion, size, sha256 } = manifest;
  const file = join(cache, `${sha256}.wasm`);
  let pending: Promise<Uint8Array<ArrayBuffer>> | undefined;

  const cached = async () => {
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile() !== true || info.size !== size) return undefined;
    const bytes = await readFile(file).catch(() => undefined);
    if (bytes?.byteLength === size && digest(bytes) === sha256) {
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return undefined;
  };

  const download = async () => {
    const options = {
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(180_000),
    } satisfies RequestInit;
    let response = await fetchAsset(
      `https://github.com/CeriumHQ/cerium/releases/download/v${version}/cerium-dictation-${version}.wasm`,
      options,
    );
    // Nightlies are pruned. The same pinned npm artifact can still satisfy the built-in checksum.
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      response = await fetchAsset(
        `https://unpkg.com/onnxruntime-web@${onnxVersion}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
        options,
      );
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`The speech runtime download returned HTTP ${response.status}.`);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    const reader = response.body.getReader();
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        if (offset + chunk.value.byteLength > size) throw new Error("Unexpected speech runtime size.");
        bytes.set(chunk.value, offset);
        offset += chunk.value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (offset !== size) throw new Error("Unexpected speech runtime size.");
    if (digest(bytes) !== sha256) throw new Error("The speech runtime checksum did not match.");

    // A quit or interruption before the rename leaves the previous cache entry intact.
    await mkdir(cache, { recursive: true });
    const staging = await mkdtemp(join(cache, "download-"));
    try {
      const staged = join(staging, "runtime.wasm");
      await writeFile(staged, bytes);
      await rename(staged, file);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    return bytes;
  };

  const load = async () => (await cached()) ?? download();
  return () =>
    (pending ??= load().finally(() => {
      pending = undefined;
    }));
};
