import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { archiveName, targets } from "../apps/cli/src/release.ts";

const installers = ["install.sh", "install.ps1"];
const archives = (version: string) => targets.map((target) => archiveName(version, target));

export const hostAssets = (version: string) => [
  ...archives(version).flatMap((name) => [name, `${name}.sha256`]),
  ...installers,
];

if (import.meta.main) {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version) throw new Error("Usage: host-release.ts <directory> <version>");
  const expected = archives(version).flatMap((name) => [name, `${name}.sha256`]);
  const files = readdirSync(directory);
  if (files.length !== expected.length || !expected.every((name) => files.includes(name)))
    throw new Error(`Incomplete or unexpected CLI artifacts for ${version}: ${files.join(", ")}`);
  for (const name of archives(version)) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
    const checksum = readFileSync(join(directory, `${name}.sha256`), "utf8").trim();
    if (checksum !== `${hash.digest("hex")}  ${name}`) throw new Error(`Invalid checksum for ${name}.`);
  }
  for (const name of installers) copyFileSync(join("apps/site/public", name), join(directory, name));
}
