import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { archiveName, compareVersions, layoutName, releaseVersion, target } from "./release.ts";
import { checksum, download, extract, sha256 } from "./download.ts";
import { manageService, serviceInstalled } from "./service.ts";

const STALE_LOCK_MS = 15 * 60_000;

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

const repo = "https://api.github.com/repos/CeriumHQ/cerium/releases";

async function releaseJson<T>(url: string): Promise<T> {
  const result = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!result.ok) throw new Error(`GitHub Releases returned ${result.status} for ${url}.`);
  return (await result.json()) as T;
}

async function lookup(channel: string, pinned: string | undefined) {
  if (pinned || channel === "stable")
    return releaseJson<Release>(pinned ? `${repo}/tags/v${releaseVersion(pinned)}` : `${repo}/latest`);
  for (let page = 1; ; page++) {
    const releases = await releaseJson<Release[]>(`${repo}?per_page=100&page=${page}`);
    const versions = releases.filter(
      (r) => !r.draft && r.prerelease && /^v\d+\.\d+\.\d+-nightly\.n?\d+$/.test(r.tag_name),
    );
    if (versions.length) return versions.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0]!;
    if (releases.length < 100) throw new Error("No published Cerium nightly release found.");
  }
}

export function updateAvailable(installed: string, requested: string, pinned: boolean) {
  const direction = compareVersions(requested, installed);
  return pinned ? direction !== 0 : direction > 0;
}

export async function checkRelease(installed: string, channel: string, pinned?: string) {
  const release = await lookup(channel, pinned);
  const version = releaseVersion(release.tag_name);
  if (release.draft) throw new Error("The requested release is still a draft.");
  if (!updateAvailable(installed, version, pinned !== undefined)) return undefined;
  const platform = target(`${process.platform}-${process.arch}`);
  const asset = archiveName(version, platform);
  if (![asset, asset + ".sha256"].every((name) => release.assets.some((item) => item.name === name)))
    throw new Error(`Release ${version} has no verified build for ${platform}.`);
  return { version, platform, asset };
}

export type AvailableRelease = NonNullable<Awaited<ReturnType<typeof checkRelease>>>;

export async function updateHost(options: {
  installed: string;
  installRoot: string | undefined;
  version: string | undefined;
  channel: string;
  check: boolean;
}) {
  const release = await checkRelease(options.installed, options.channel, options.version);
  if (!release) return console.log(`Cerium Host ${options.installed} is up to date.`);
  console.log(`Cerium Host ${options.installed} → ${release.version}`);
  if (!options.installRoot)
    return console.log(
      `Install with npm install -g @cerium/host@${release.version}, then restart a running host.`,
    );
  if (options.check) return;
  const tty = process.stdout.isTTY === true;
  let lastPercent = -1;
  const staged = await prepareRelease(options.installRoot, release, (percent) => {
    if (tty) {
      if (percent !== lastPercent) {
        lastPercent = percent;
        process.stdout.write(`\rDownloading ${release.asset}... ${percent}%`);
      }
    } else if (percent === 100 || percent - lastPercent >= 25) {
      lastPercent = percent;
      console.log(`Downloading ${release.asset}... ${percent}%`);
    }
  });
  if (tty && lastPercent >= 0) process.stdout.write("\n");
  try {
    await staged.activate(() => {
      if (serviceInstalled()) manageService("restart");
    });
    console.log(`Installed Cerium Host ${release.version}.`);
  } finally {
    await staged.discard();
  }
}

export async function prepareRelease(
  root: string,
  release: AvailableRelease,
  progress?: (percent: number) => void,
  signal?: AbortSignal,
) {
  const { version, asset, platform } = release;
  const releases = join(root, "releases");
  await mkdir(releases, { recursive: true });
  const work = await mkdtemp(join(releases, ".update-"));
  const pointer = join(root, "current-version");
  const original = existsSync(pointer) ? await readFile(pointer, "utf8") : undefined;
  try {
    const url = `https://github.com/CeriumHQ/cerium/releases/download/v${version}/${asset}`;
    const file = join(work, asset);
    await download(url + ".sha256", file + ".sha256", undefined, signal);
    await download(url, file, progress, signal);
    if ((await sha256(file)) !== checksum(await readFile(file + ".sha256", "utf8"), asset))
      throw new Error(`The SHA-256 of ${asset} does not match the release checksum.`);
    extract(file, work);
    const extracted = join(work, layoutName(version, platform));
    const node = join(extracted, "runtime", process.platform === "win32" ? "node.exe" : "bin/node");
    const actual = execFileSync(node, [join(extracted, "dist", "cli.mjs"), "--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    if (actual !== version)
      throw new Error(`Downloaded host reports version ${actual} (expected ${version}).`);
    return {
      activate: (restart: () => void) => activateRelease(root, work, extracted, version, original, restart),
      discard: () => rm(work, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}

async function acquireInstallLock(lock: string, staleAfterMs = STALE_LOCK_MS) {
  try {
    await mkdir(lock);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await stat(lock).catch(() => undefined);
  if (info && Date.now() - info.mtimeMs >= staleAfterMs) {
    await rm(lock, { recursive: true, force: true });
    try {
      await mkdir(lock);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(
    `Another Cerium Host install or update is in progress (${lock}). Wait for it to finish, or remove that path if an earlier update crashed.`,
  );
}

/** Keeps the active release and one previous release for rollback, removing older directories. */
export async function pruneReleases(root: string, keep: ReadonlyArray<string | undefined>) {
  const releases = join(root, "releases");
  const retained = new Set(
    keep.map((entry) => entry?.trim()).filter((entry): entry is string => Boolean(entry)),
  );
  const entries = await readdir(releases, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || retained.has(entry.name)) continue;
    await rm(join(releases, entry.name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Serialize the pointer swap with other updaters and the public installer. */
export async function activateRelease(
  root: string,
  work: string,
  extracted: string,
  version: string,
  original: string | undefined,
  restart: () => void,
  staleLockMs = STALE_LOCK_MS,
) {
  const lock = join(root, ".install-lock");
  await acquireInstallLock(lock, staleLockMs);
  try {
    const pointer = join(root, "current-version");
    const previous = existsSync(pointer) ? await readFile(pointer, "utf8") : undefined;
    if (previous !== original)
      throw new Error("Another host update finished during the download. Check again.");
    // Windows keeps a running binary locked. Each candidate gets its own release directory.
    const directory = `${releaseVersion(version)}-${randomUUID()}`;
    await rename(extracted, join(root, "releases", directory));
    const next = join(work, "pointer");
    await writeFile(next, directory + "\n");
    await rename(next, pointer);
    try {
      restart();
    } catch (error) {
      if (previous !== undefined) {
        await writeFile(next, previous);
        await rename(next, pointer);
      } else await rm(pointer);
      restart();
      throw error;
    }
    await pruneReleases(root, [directory, previous]);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
