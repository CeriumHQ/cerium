// Fetches earlier releases' web UI builds into dist/builds, so a deploy keeps serving every version
// desktops still run. Each release carries its build as
// `cerium-web-<version>.tar.gz`; the newest ones are kept, up to MAX_BUILDS. Needs the GitHub CLI,
// signed in or given GH_TOKEN, and reads the repository from GH_REPO or the checkout's remote.
// Without it, a deploy serves only this checkout's build, and says so. It also leaves the newest
// stable release's version in dist/builds/stable.txt, which the website's downloads follow.
//
// Usage: node scripts/builds.ts

import { execFile, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** Each build takes two of the hundred `_headers` rules Cloudflare reads (scripts/layout.ts). */
const MAX_BUILDS = 40;
const DOWNLOAD_CONCURRENCY = 4;
const ASSET = /^cerium-web-(.+)\.tar\.gz$/;

const out = join(import.meta.dirname, "..", "dist", "builds");
const exec = promisify(execFile);

const keepBuild = (download: string): boolean => {
  if (!existsSync(download)) return false;
  const archive = readdirSync(download).find((name) => ASSET.test(name));
  const version = archive?.match(ASSET)?.[1];
  if (archive === undefined || version === undefined) return false;
  const folder = join(out, version);
  if (dirname(folder) !== out || version.toLowerCase() === "stable.txt" || existsSync(folder)) return false;

  const unpacking = mkdtempSync(join(out, ".unpack-"));
  try {
    // Read from stdin: Git Bash's tar takes a drive letter in an archive's path for a remote host.
    const input = openSync(join(download, archive), "r");
    try {
      const unpacked = spawnSync("tar", ["-xzf", "-"], {
        cwd: unpacking,
        encoding: "utf8",
        stdio: [input, "ignore", "pipe"],
      });
      if (unpacked.status !== 0) {
        console.warn(`Couldn't unpack ${archive}: ${unpacked.error?.message ?? unpacked.stderr.trim()}`);
        return false;
      }
    } finally {
      closeSync(input);
    }
    renameSync(unpacking, folder);
    return true;
  } finally {
    rmSync(unpacking, { recursive: true, force: true });
  }
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Drafts, which CI gathers a nightly's packages in before publishing it, aren't released yet.
let releases: Array<{ tagName: string; isPrerelease: boolean }>;
try {
  const { stdout } = await exec("gh", [
    "release",
    "list",
    "--exclude-drafts",
    "--limit",
    "100",
    "--json",
    "tagName,isPrerelease",
  ]);
  releases = JSON.parse(stdout) as typeof releases;
} catch (error) {
  console.warn(`Couldn't list Cerium's releases, so only this checkout's web UI is served: ${String(error)}`);
  process.exit(0);
}

// The website's downloads name the newest stable release, never a nightly (scripts/layout.ts).
const stable = releases.find((release) => !release.isPrerelease)?.tagName.replace(/^v/, "");
if (stable !== undefined) writeFileSync(join(out, "stable.txt"), stable);

let kept = 0;
let next = 0;
while (next < releases.length && kept < MAX_BUILDS) {
  // Keep at most one batch on disk and stop downloading at the release that fills the last slot.
  const batch = releases.slice(next, next + Math.min(DOWNLOAD_CONCURRENCY, MAX_BUILDS - kept));
  const downloads = mkdtempSync(join(tmpdir(), "cerium-web-"));
  try {
    const fetched = await Promise.all(
      batch.map(async ({ tagName }, index) => {
        const into = join(downloads, String(index));
        try {
          await exec("gh", [
            "release",
            "download",
            tagName,
            "--pattern",
            "cerium-web-*.tar.gz",
            "--dir",
            into,
          ]);
          return into;
        } catch {
          return undefined; // Released before builds were kept, or without one.
        }
      }),
    );
    // Process in the CLI's newest-first order, even when older downloads finish first.
    for (const download of fetched) {
      if (download !== undefined && keepBuild(download)) kept += 1;
    }
  } finally {
    rmSync(downloads, { recursive: true, force: true });
  }
  next += batch.length;
}
console.log(`Fetched ${kept} earlier web UI builds.`);
