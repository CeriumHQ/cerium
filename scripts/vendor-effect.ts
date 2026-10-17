// Fetches the Effect source at the exact version Cerium depends on into vendor/effect,
// so contributors and coding agents can read the real v4 APIs instead of recalling v3 ones.
//
// Usage: bun run vendor:effect [--force]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const target = join(root, "vendor", "effect");
const stamp = join(target, ".cerium-version");
const force = process.argv.includes("--force");

// @cerium/protocol pins the exact Effect version every other package follows.
const pinnedVersion = (): string => {
  const pkg = join(root, "packages", "protocol", "package.json");
  const { dependencies } = JSON.parse(readFileSync(pkg, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const version = dependencies["effect"];
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected an exact effect version in ${pkg}, found ${version}`);
  }
  return version;
};

const version = pinnedVersion();

if (!force && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) {
  console.log(`vendor/effect is already at effect@${version}`);
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
console.log(`Fetching effect@${version} source into vendor/effect ...`);
execFileSync(
  "git",
  [
    "clone",
    "--depth=1",
    "--branch",
    `effect@${version}`,
    "--single-branch",
    "https://github.com/Effect-TS/effect.git",
    target,
  ],
  { stdio: "inherit" },
);
rmSync(join(target, ".git"), { recursive: true, force: true });
writeFileSync(stamp, `${version}\n`);
console.log(`vendor/effect now matches effect@${version}`);
