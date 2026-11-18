import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dictationRuntime, runtimeManifest } from "../src/dictationRuntime.ts";

const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const manifest = {
  version: "1.2.3-nightly.n42",
  onnxVersion: "1.31.0-dev.20260914-8d85527a0",
  size: wasm.byteLength,
  sha256: createHash("sha256").update(wasm).digest("hex"),
};
const asset = `https://github.com/CeriumHQ/cerium/releases/download/v${manifest.version}/cerium-dictation-${manifest.version}.wasm`;

let cache: string;
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "cerium-dictation-test-"));
});
afterEach(async () => rm(cache, { recursive: true, force: true }));

describe("the optional dictation runtime", () => {
  it("accepts only metadata for the running version", () => {
    expect(runtimeManifest(manifest, manifest.version)).toEqual(manifest);
    expect(runtimeManifest(manifest, "1.2.3")).toBeUndefined();
    expect(runtimeManifest({ ...manifest, sha256: "../wasm" }, manifest.version)).toBeUndefined();
    expect(runtimeManifest({ ...manifest, onnxVersion: "latest" }, manifest.version)).toBeUndefined();
  });

  it("loads lazily, shares concurrent downloads and reuses verified bytes offline across updates", async () => {
    const fetchAsset = vi.fn<typeof fetch>().mockResolvedValue(new Response(wasm));
    const load = dictationRuntime(cache, manifest, fetchAsset);
    expect(fetchAsset).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toEqual(wasm);
    expect(second).toEqual(wasm);
    expect(fetchAsset).toHaveBeenCalledExactlyOnceWith(
      asset,
      expect.objectContaining({ credentials: "omit" }),
    );

    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("Offline"));
    const loadAfterUpdate = dictationRuntime(cache, { ...manifest, version: "1.2.3" }, offline);
    await expect(loadAfterUpdate()).resolves.toEqual(wasm);
    expect(offline).not.toHaveBeenCalled();
  });

  it("rejects wrong-sized or corrupt bytes and retries after an interrupted or failed download", async () => {
    const badBytes = new Uint8Array(wasm.byteLength);
    await writeFile(join(cache, `${manifest.sha256}.wasm`), badBytes);
    const fetchAsset = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(new Response(wasm.slice(1)))
      .mockResolvedValueOnce(new Response(new Uint8Array(wasm.byteLength + 1)))
      .mockResolvedValueOnce(new Response(badBytes))
      .mockResolvedValueOnce(new Response(wasm));
    const load = dictationRuntime(cache, manifest, fetchAsset);
    await expect(load()).rejects.toThrow("Offline");
    await expect(load()).rejects.toThrow("size");
    await expect(load()).rejects.toThrow("size");
    await expect(load()).rejects.toThrow("checksum");
    await expect(load()).resolves.toEqual(wasm);
    await expect(load()).resolves.toEqual(wasm);
    expect(fetchAsset).toHaveBeenCalledTimes(5);
  });

  it("uses the pinned npm version when the release asset no longer exists", async () => {
    const fetchAsset = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(wasm));
    await expect(dictationRuntime(cache, manifest, fetchAsset)()).resolves.toEqual(wasm);
    expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual([
      asset,
      `https://unpkg.com/onnxruntime-web@${manifest.onnxVersion}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
    ]);
  });
});
