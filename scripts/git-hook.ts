// Vite+ installs the repository's Git hook shims during bun install. Fetch hk on first local
// use so CI dependency installation and packaging do not need a hook runner.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = "2.13.0";
const assets = {
  "aarch64-apple-darwin": "64efc441dc0858a175909fd6253ddd6c540da80e7d1bd2a2ad0ec9c0cdab3d97",
  "aarch64-pc-windows-msvc": "54d34ae2e9ce7307658c69021801a2aad64149614eab60640dab7a63a18e2025",
  "x86_64-pc-windows-msvc": "2908de6281368b8128f1d4d7a03905d3ab0eb86a82641d6055be88806bf9ffac",
  "aarch64-unknown-linux-musl": "cff2d433a82104ace7084a23970ff05b0bf3ca529e00c61da20780104106a3dd",
  "x86_64-unknown-linux-musl": "3d5ae62e2befe95fa6fc7ffd63a0876c3efe3409634fbd6561b8bb0be787eeae",
};

const hk = async (): Promise<string> => {
  const cpuNames: Partial<Record<NodeJS.Architecture, string>> = { arm64: "aarch64", x64: "x86_64" };
  const osNames: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "apple-darwin",
    win32: "pc-windows-msvc",
    linux: "unknown-linux-musl",
  };
  const cpu = cpuNames[process.arch];
  const os = osNames[process.platform];
  const target = `${cpu}-${os}`;
  const cache = join(import.meta.dirname, "..", "node_modules", ".cache", "hk");
  const folder = join(cache, `${version}-${target}`);
  const windows = process.platform === "win32";
  const binary = windows ? "hk.exe" : "hk";
  const path = join(folder, binary);
  if (existsSync(path)) return path;
  if (!Object.hasOwn(assets, target)) {
    if (spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout?.trim() === `hk ${version}`)
      return binary;
    throw new Error(
      `Install hk ${version} on PATH. Upstream has no pinned binary for ${process.platform}-${process.arch}.`,
    );
  }
  const name = `hk-${target}.${windows ? "zip" : "tar.gz"}`;
  const response = await fetch(`https://github.com/jdx/hk/releases/download/v${version}/${name}`);
  if (!response.ok) throw new Error(`Downloading ${name} failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== assets[target as keyof typeof assets]) {
    throw new Error(`Incorrect checksum for ${name}`);
  }
  mkdirSync(cache, { recursive: true });
  const temp = mkdtempSync(join(cache, "install-"));
  try {
    const archive = join(temp, name);
    writeFileSync(archive, bytes);
    const unpack = spawnSync(windows ? "tar.exe" : "tar", ["-xf", archive, "-C", temp, binary], {
      stdio: "inherit",
    });
    if (unpack.status !== 0) throw new Error(`Could not unpack ${name}`);
    rmSync(archive);
    try {
      renameSync(temp, folder);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return path;
};

const result = spawnSync(await hk(), ["run", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
