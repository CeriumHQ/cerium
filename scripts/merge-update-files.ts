// Collect release artifacts from one runner per platform. Each platform owns its update feed.
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export function gatherPackages(from: string, to: string) {
  const files = new Map<string, string>();
  for (const folder of readdirSync(from, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const directory = join(from, folder.name);
    for (const name of readdirSync(directory)) {
      if (files.has(name)) throw new Error(`Multiple runners supplied ${name}.`);
      files.set(name, join(directory, name));
    }
  }
  if (!files.size) throw new Error("No release files to publish.");
  mkdirSync(to, { recursive: true });
  for (const [name, source] of files) renameSync(source, join(to, name));
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) throw new Error("Usage: node scripts/merge-update-files.ts <from> <to>");
  gatherPackages(from, to);
}
