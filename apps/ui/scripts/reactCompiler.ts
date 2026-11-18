import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Plugin, Rolldown } from "vite-plus";

const maxCacheBytes = 16 * 1024 * 1024;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

type Compiled = { code: string; map: Rolldown.SourceMapInput };

const isCompiled = (result: unknown): result is Compiled =>
  typeof result === "object" &&
  result !== null &&
  "code" in result &&
  typeof result.code === "string" &&
  "map" in result &&
  (result.map === null ||
    (typeof result.map === "object" && "mappings" in result.map && typeof result.map.mappings === "string"));

async function readCache(file: string, fingerprint: string): Promise<Map<string, Compiled>> {
  try {
    if ((await stat(file)).size > maxCacheBytes) return new Map();
    const contents = await readFile(file, "utf8");
    const payload = contents.slice(65);
    if (contents[64] !== "\n" || sha256(payload) !== contents.slice(0, 64)) return new Map();

    const cache: unknown = JSON.parse(payload);
    if (
      typeof cache === "object" &&
      cache &&
      "fingerprint" in cache &&
      cache.fingerprint === fingerprint &&
      "entries" in cache &&
      typeof cache.entries === "object" &&
      cache.entries
    ) {
      return new Map(
        Object.entries(cache.entries).filter((entry): entry is [string, Compiled] => isCompiled(entry[1])),
      );
    }
  } catch {
    // The cache can disappear between reads, fail to decode, or be unavailable.
  }
  return new Map();
}

async function writeCache(file: string, fingerprint: string, entries: Map<string, Compiled>) {
  const keys = [...entries.keys()].sort();
  const payload = JSON.stringify({
    fingerprint,
    entries: Object.fromEntries(keys.map((key) => [key, entries.get(key)])),
  });
  if (Buffer.byteLength(payload) + 65 > maxCacheBytes) return;

  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, `${sha256(payload)}\n${payload}`);
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Babel disables babelrc/configFile but can still discover Browserslist config above its cwd. */
async function hasBrowserslistConfig(dir: string): Promise<boolean> {
  const readOptional = async (name: string) => {
    try {
      return await readFile(join(dir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  };
  const [rc, config, manifest] = await Promise.all(
    [".browserslistrc", "browserslist", "package.json"].map(readOptional),
  );
  if (
    rc !== undefined ||
    config !== undefined ||
    (manifest && Object.hasOwn(JSON.parse(manifest), "browserslist"))
  ) {
    return true;
  }
  const parent = dirname(dir);
  return parent !== dir && hasBrowserslistConfig(parent);
}

async function compilerFingerprint(mode: string) {
  const env = process.env;
  // These options request diagnostics or permit external Babel inputs. Let Babel run normally.
  if (
    env["DEBUG"] ||
    env["BABEL_SHOW_CONFIG_FOR"] ||
    env["ENABLE_REACT_COMPILER_TIMINGS"] === "1" ||
    Object.keys(env).some((name) => name.startsWith("BROWSERSLIST"))
  ) {
    return;
  }
  try {
    const cwd = process.cwd();
    if (await hasBrowserslistConfig(cwd)) return;
    // Frozen installs pin Babel, the compiler, Rolldown, Vite, and their transitive dependencies.
    // Hash the config and this module, where the preset and its options are defined.
    const files = [
      "../../../bun.lock",
      "../../../package.json",
      "../package.json",
      "../vite.config.ts",
      "./reactCompiler.ts",
    ];
    const digests = await Promise.all(
      files.map(async (file) => sha256(await readFile(new URL(file, import.meta.url)))),
    );
    return sha256(
      JSON.stringify([
        digests,
        cwd,
        mode,
        process.versions,
        process.platform,
        process.arch,
        env["NODE_ENV"],
        env["BABEL_ENV"],
        env["BABEL_TYPES_8_BREAKING"],
      ]),
    );
  } catch {
    // If an input cannot be fingerprinted, leave the compiler uncached.
  }
}

/** Persist only the existing Babel hook's output. Rolldown still composes its sourcemaps and bundles. */
export async function reactCompiler(cachePath: string | undefined, mode: string): Promise<Plugin> {
  // The Babel package declares a Rolldown plugin, but provides Vite-specific hooks and context.
  const plugin = (await babel({ presets: [reactCompilerPreset()] })) as Plugin;
  const transform = plugin.transform;
  if (
    !cachePath ||
    !transform ||
    typeof transform === "function" ||
    plugin.buildStart ||
    plugin.writeBundle
  ) {
    return plugin;
  }

  const file = resolve(cachePath);
  const previousHandler = transform.handler;
  let fingerprint: string | undefined;
  let previous = new Map<string, Compiled>();
  const used = new Map<string, Compiled>();
  let hits = 0;
  let misses = 0;

  plugin.buildStart = async () => {
    fingerprint = await compilerFingerprint(mode);
    if (fingerprint) previous = await readCache(file, fingerprint);
  };
  // Keep the original hook object: Babel fills in its filter in configResolved.
  transform.handler = async function (code, id, options) {
    if (!fingerprint || code.length > 500_000) {
      // Babel reports when it switches very large files to compact output.
      return previousHandler.call(this, code, id, options);
    }

    // Use the hook's actual input after all earlier transforms, with its original ID and map.
    const key = sha256(
      JSON.stringify([id, options?.moduleType, this.environment.name, code, this.getCombinedSourcemap()]),
    );
    const cached = used.get(key) ?? previous.get(key);
    if (cached) {
      hits++;
      used.set(key, cached);
      return cached;
    }
    misses++;
    const result = await previousHandler.call(this, code, id, options);
    if (isCompiled(result)) used.set(key, result);
    return result;
  };
  plugin.writeBundle = async function () {
    if (!fingerprint || used.size === 0) return;
    await writeCache(file, fingerprint, used);
    this.info(`React compiler cache: ${hits} hits, ${misses} misses`);
  };
  return plugin;
}
