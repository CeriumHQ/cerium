import type { Configuration } from "electron-builder";

// Packages the desktop shell and its backend into an unsigned Windows installer
// (docs/architecture.md §10). The release workflows set CERIUM_CHANNEL and CERIUM_VERSION from
// scripts/release.ts; without them this builds a stable-named installer at the package's own version.

const nightly = process.env["CERIUM_CHANNEL"] === "nightly";
const version = process.env["CERIUM_VERSION"];

// Nightlies install beside the stable app, under their own name, app id and data folder.
const productName = nightly ? "Cerium Nightly" : "Cerium";

export default {
  appId: nightly ? "app.cerium.desktop.nightly" : "app.cerium.desktop",
  productName,
  // Electron names the user-data folder after the packaged package.json's productName; the installer
  // names its own folders after `name`, which mustn't be the workspace's scoped name.
  extraMetadata: {
    name: nightly ? "cerium-nightly" : "cerium",
    productName,
    ...(version === undefined ? {} : { version }),
  },
  directories: { output: "out" },
  // The backend's npm packages come along as @cerium/backend's dependencies. Its own code is bundled
  // into dist/backend.mjs, so Cerium's TypeScript packages stay out, and so do the Claude Agent SDK's
  // bundled `claude` binaries: Cerium always runs the user's own.
  files: [
    "dist/**",
    "package.json",
    { from: "../../packages/store/migrations", to: "migrations" },
    "!node_modules/@cerium/**",
    "!node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  // main.ts loads the UI from ../../ui/dist beside dist/, which is resources/ui/dist once packaged.
  extraResources: [{ from: "../ui/dist", to: "ui/dist" }],
  // No asar archive: the Cursor SDK runs ripgrep and its sandbox from node_modules, and finds them by
  // walking up from the backend's script, which an archive would hide.
  asar: false,
  // koffi ships prebuilt for Electron's Node-API, so nothing needs rebuilding.
  npmRebuild: false,
  win: { target: "nsis" },
  nsis: { artifactName: `${nightly ? "Cerium-Nightly" : "Cerium"}-Setup-\${version}.\${ext}` },
  publish: null,
} satisfies Configuration;
