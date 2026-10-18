// Puts together what the relay serves (docs/architecture.md §14.10): its own pages from public/ and
// the web UI's build from apps/ui/dist-web, which `bun run --cwd apps/ui build:web` makes. Wrangler
// runs this before `dev` and `deploy`; `_headers` rules from both are kept.
//
// Usage: node scripts/assets.ts

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const relay = join(import.meta.dirname, "..");
const out = join(relay, "dist", "assets");
const pages = join(relay, "public");
const web = join(relay, "..", "ui", "dist-web");

const headers = (folder: string) => {
  const file = join(folder, "_headers");
  return existsSync(file) ? readFileSync(file, "utf8").trimEnd() : "";
};

// Emptied rather than removed: a running `wrangler dev` holds the folder open on Windows.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) rmSync(join(out, entry), { recursive: true, force: true });
if (existsSync(web)) cpSync(web, out, { recursive: true });
else
  console.warn("The web UI isn't built, so / has nothing to serve: run `bun run --cwd apps/ui build:web`.");
cpSync(pages, out, { recursive: true });

const rules = [headers(web), headers(pages)].filter((rule) => rule !== "").join("\n\n");
if (rules !== "") writeFileSync(join(out, "_headers"), `${rules}\n`);
