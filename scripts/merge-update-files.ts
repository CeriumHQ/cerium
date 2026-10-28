// Gathers the packages each release runner built into one folder for publishing. Runners that
// package the same system for different processors each write that system's update file under the
// same name (latest.yml or nightly.yml from both Windows runners), so the files those runners share
// are merged: one update file listing every processor's package, from which electron-updater picks
// the one whose name carries its own processor (apps/desktop/electron-builder.ts). The Linux runners
// join the update files of the packages they pack side by side the same way
// (.github/actions/package).
//
// Usage: node scripts/merge-update-files.ts <from> <to>
// <from> holds one folder per runner's package artifact, or per Linux package; every file in them is
// moved to <to>, which on the same disk takes no time where copying the packages took half a minute.
// The folders are read in order of their names, which lists a merged file's packages in that order.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An update file's lines, with its `files:` list's lines apart from the rest. */
const split = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const start = lines.indexOf("files:");
  if (start === -1) throw new Error("An update file without a `files:` list.");
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith(" ")) end += 1;
  const entries: string[][] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith("  - ")) entries.push([line]);
    else entries.at(-1)?.push(line);
  }
  const version = lines.find((line) => line.startsWith("version: "));
  return { before: lines.slice(0, start + 1), entries, after: lines.slice(end), version };
};

const urlOf = (entry: ReadonlyArray<string>) => entry[0]!.replace(/^ {2}- url: /, "");

/**
 * One update file listing every file `texts` list, in their order. The x64 file's other fields stay:
 * its `path` and `sha512` are what updaters older than the `files:` list read.
 */
export const mergeUpdateFiles = (texts: ReadonlyArray<string>): string => {
  const parsed = texts.map(split);
  const versions = new Set(parsed.map((file) => file.version));
  if (versions.size > 1)
    throw new Error(`The update files name different versions: ${[...versions].join(", ")}`);
  const primary =
    parsed.find((file) => file.after.some((line) => /^path: .*(x64|x86_64|amd64)/.test(line))) ?? parsed[0]!;
  const entries = new Map<string, ReadonlyArray<string>>();
  for (const file of [primary, ...parsed.filter((file) => file !== primary)]) {
    for (const entry of file.entries) if (!entries.has(urlOf(entry))) entries.set(urlOf(entry), entry);
  }
  return `${[...primary.before, ...[...entries.values()].flat(), ...primary.after].join("\n")}\n`;
};

const isUpdateFile = (name: string) => /^(latest|nightly)(-[a-z0-9-]+)?\.yml$/.test(name);

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (from === undefined || to === undefined) {
    console.error("Usage: node scripts/merge-update-files.ts <from> <to>");
    process.exit(2);
  }
  const byName = new Map<string, string[]>();
  const folders = readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(join(from, folder.name))) {
      byName.set(name, [...(byName.get(name) ?? []), join(from, folder.name, name)]);
    }
  }
  mkdirSync(to, { recursive: true });
  for (const [name, paths] of byName) {
    if (paths.length === 1) {
      renameSync(paths[0]!, join(to, name));
    } else if (isUpdateFile(name)) {
      writeFileSync(join(to, name), mergeUpdateFiles(paths.map((path) => readFileSync(path, "utf8"))));
      console.log(`Merged ${name} from ${paths.length} runners.`);
    } else {
      throw new Error(`${paths.length} runners built ${name}; only update files are merged.`);
    }
  }
}
