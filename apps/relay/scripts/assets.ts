// Puts together what the relay serves: Cerium's website at the root, its own pages from public/,
// and the web UI, one build per version of Cerium. Each build is served under `/v/<version>/`, and
// this checkout's (apps/ui/dist-web, which `bun run --cwd apps/ui build:web` makes) at `/app/` as
// well; a browser driving a desktop moves to the build of that desktop's version. The website is
// apps/site/dist, which `bun run --cwd apps/site build` makes. Earlier releases' builds come from
// dist/builds, which scripts/builds.ts fills. Wrangler runs this before `dev` and `deploy`, and it
// writes `_headers` for every build's page and `_redirects` for the installer's download, which
// names the newest stable release even when a nightly is what deploys.
//
// Usage: node scripts/assets.ts

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APP_PATH, layOut, redirects, type WebBuild } from "./layout.ts";

const relay = join(import.meta.dirname, "..");
const out = join(relay, "dist", "assets");
const pages = join(relay, "public");
const current = join(relay, "..", "ui", "dist-web");
const website = join(relay, "..", "site", "dist");
const fetched = join(relay, "dist", "builds");

/** A build's folder, if it holds a web build. */
const readBuild = (folder: string): WebBuild | undefined => {
  const file = join(folder, "build.json");
  if (!existsSync(file)) return undefined;
  const { version, pageHeaders } = JSON.parse(readFileSync(file, "utf8")) as Omit<WebBuild, "folder">;
  return { folder, version, pageHeaders };
};

const root = readBuild(current);
if (root === undefined)
  console.warn(
    `The web UI isn't built, so ${APP_PATH} has nothing to serve: run \`bun run --cwd apps/ui build:web\`.`,
  );
if (!existsSync(join(website, "index.html")))
  console.warn("The website isn't built, so / has nothing to serve: run `bun run --cwd apps/site build`.");
const earlier = existsSync(fetched)
  ? readdirSync(fetched).flatMap((name) => readBuild(join(fetched, name)) ?? [])
  : [];
const pageRules = join(pages, "_headers");
const { builds, headers } = layOut(
  root,
  earlier,
  existsSync(pageRules) ? readFileSync(pageRules, "utf8") : "",
);

// Emptied rather than removed: a running `wrangler dev` holds the folder open on Windows.
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) rmSync(join(out, entry), { recursive: true, force: true });
for (const build of builds) cpSync(build.folder, join(out, "v", build.version), { recursive: true });
if (root !== undefined) {
  // The app's page, and the files every version shares at the root: the service worker, manifest
  // and icons.
  for (const entry of readdirSync(root.folder)) {
    if (entry === "index.html") cpSync(join(root.folder, entry), join(out, APP_PATH, entry));
    else if (entry !== "assets" && entry !== "build.json")
      cpSync(join(root.folder, entry), join(out, entry), { recursive: true });
  }
}
if (existsSync(website)) cpSync(website, out, { recursive: true });
cpSync(pages, out, { recursive: true });
mkdirSync(join(out, "v"), { recursive: true });
writeFileSync(
  join(out, "v", "builds.json"),
  `${JSON.stringify({ versions: builds.map((build) => build.version) })}\n`,
);
writeFileSync(join(out, "_headers"), headers);
const stableFile = join(fetched, "stable.txt");
writeFileSync(
  join(out, "_redirects"),
  redirects(root, existsSync(stableFile) ? readFileSync(stableFile, "utf8").trim() : undefined),
);
console.log(`Web UI builds: ${builds.map((build) => build.version).join(", ") || "none"}.`);
