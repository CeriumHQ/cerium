import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Target } from "../src/release.ts";

export const root = resolve(import.meta.dirname, "..");
export const nodeVersion = "24.22.1";

export function keepDependency(path: string, platform?: Target) {
  const name = path.split(sep).join("/");
  if (/(^|\/)node_modules\/(?:\.bin|@types)(?:\/|$)/.test(name)) return false;
  if (/\.(?:ts|cts|mts|tsx|map)$/.test(name)) return false;
  if (/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/.test(name)) return false;
  if (/node_modules\/@cursor\/sdk\/dist\/(?:bundled|cjs)(?:\/|$)/.test(name)) return false;
  if (/node_modules\/drizzle-orm\/.*\.cjs$/.test(name)) return false;
  const prebuild = /node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(name);
  return !platform || !prebuild || platform === prebuild[1];
}

export async function manifest(version?: string) {
  const source = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  delete source.devDependencies;
  delete source.scripts;
  source.bin["cerium-host"] = "bin/cerium-host.mjs";
  if (version !== undefined) source.version = version;
  return source;
}

export async function stage(directory: string, version?: string) {
  await mkdir(directory, { recursive: true });
  for (const path of ["dist", "migrations", "README.md", "LICENSE", "bin/cerium-host.mjs"]) {
    await cp(join(root, path), join(directory, path), { recursive: true });
  }
  await writeFile(join(directory, "package.json"), JSON.stringify(await manifest(version), null, 2) + "\n");
}

export async function stageNpm(directory: string, version?: string) {
  await rm(directory, { recursive: true, force: true });
  await stage(directory, version);
  // Materialize Bun's patched package. npm omits workspace symlinks when packing bundled dependencies.
  const pty = await realpath(join(root, "node_modules/node-pty"));
  const target = join(directory, "node_modules/node-pty");
  await cp(pty, target, { recursive: true, filter: (file) => keepDependency(file) });
  const source = resolve(pty, "../node-addon-api");
  await cp(await realpath(source), join(directory, "node_modules/node-addon-api"), { recursive: true });
  await assertPtyPatch(directory);
}

export async function assertPtyPatch(directory: string) {
  const agent = await readFile(join(directory, "node_modules/node-pty/lib/windowsPtyAgent.js"), "utf8");
  if (
    !agent.includes("_this._conoutSocketWorker.dispose();") ||
    !agent.includes("_this._inSocket.destroy();")
  )
    throw new Error("node-pty lacks Cerium's ConPTY cleanup patch.");
}
