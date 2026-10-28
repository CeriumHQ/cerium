// Fetches earlier releases' web UI builds into dist/builds, so a deploy keeps serving every version
// desktops still run. Each release carries its build as
// `cerium-web-<version>.tar.gz`; the newest ones are kept, up to MAX_BUILDS. Needs the GitHub CLI,
// signed in or given GH_TOKEN, and reads the repository from GH_REPO or the checkout's remote.
// Without it, a deploy serves only this checkout's build, and says so. It also leaves the newest
// stable release's version in dist/builds/stable.txt, which the website's downloads follow.
//
// Usage: node scripts/builds.ts

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Each build takes two of the hundred `_headers` rules Cloudflare reads (scripts/layout.ts). */
const MAX_BUILDS = 40;
const ASSET = /^cerium-web-(.+)\.tar\.gz$/;

const out = join(import.meta.dirname, "..", "dist", "builds");

const gh = (args: ReadonlyArray<string>) => {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim());
  }
  return result.stdout;
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Drafts, which CI gathers a nightly's packages in before publishing it, aren't released yet.
let releases: Array<{ tagName: string; isPrerelease: boolean }>;
try {
  releases = JSON.parse(
    gh(["release", "list", "--exclude-drafts", "--limit", "100", "--json", "tagName,isPrerelease"]),
  ) as typeof releases;
} catch (error) {
  console.warn(`Couldn't list Cerium's releases, so only this checkout's web UI is served: ${String(error)}`);
  process.exit(0);
}

// The website's downloads name the newest stable release, never a nightly (scripts/layout.ts).
const stable = releases.find((release) => !release.isPrerelease)?.tagName.replace(/^v/, "");
if (stable !== undefined) writeFileSync(join(out, "stable.txt"), stable);

const downloads = mkdtempSync(join(tmpdir(), "cerium-web-"));
let kept = 0;
// Newest first, as the CLI lists them.
for (const { tagName } of releases) {
  if (kept === MAX_BUILDS) break;
  const into = join(downloads, tagName);
  try {
    gh(["release", "download", tagName, "--pattern", "cerium-web-*.tar.gz", "--dir", into]);
  } catch {
    continue; // Released before builds were kept, or without one.
  }
  const archive = readdirSync(into).find((name) => ASSET.test(name));
  const version = archive?.match(ASSET)?.[1];
  if (archive === undefined || version === undefined) continue;
  const folder = join(out, version);
  mkdirSync(folder, { recursive: true });
  // Read from stdin: Git Bash's tar takes a drive letter in an archive's path for a remote host.
  const unpacked = spawnSync("tar", ["-xzf", "-"], { cwd: folder, input: readFileSync(join(into, archive)) });
  if (unpacked.status !== 0) {
    console.warn(`Couldn't unpack ${archive}: ${String(unpacked.stderr)}`);
    rmSync(folder, { recursive: true, force: true });
    continue;
  }
  kept += 1;
}
rmSync(downloads, { recursive: true, force: true });
console.log(`Fetched ${kept} earlier web UI builds.`);
