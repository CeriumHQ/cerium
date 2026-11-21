import { statSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { type AfterPackContext, type Configuration } from "electron-builder";

// Release assets are built and smoke-tested on the native runner for each supported target.
const version = process.env["CERIUM_VERSION"];
const nightly = version?.includes("-nightly.") === true;
const checkOnly = process.env["CERIUM_CHECK_ONLY"] === "true";
/**
 * A Developer ID certificate to sign the Mac app with (CSC_LINK, set by the release workflows when
 * the repository has one), which also has it notarized when APPLE_API_KEY and its ID and issuer are
 * set. Without one the app is signed ad hoc: it runs on Apple silicon, the user lets it open once in
 * Privacy & Security, and a helper installs updates after the app quits (src/macUpdates.ts).
 */
const developerId = Boolean(process.env["CSC_LINK"] || process.env["CSC_NAME"]);
/** Wrap Electron's original Chromium notices in a self-contained HTML reader before signing. */
const compressChromiumNotices = async (context: AfterPackContext) => {
  const name = "LICENSES.chromium.html";
  const resources = context.packager.getResourcesDir(context.appOutDir);
  // electron-builder moves the original into the Mac bundle and leaves it beside the executable elsewhere.
  const source = join(context.electronPlatformName === "darwin" ? resources : context.appOutDir, name);
  const [notices, reader] = await Promise.all([
    readFile(source),
    readFile(join(import.meta.dirname, "build", "chromium-notices.html"), "utf8"),
  ]);
  if (notices.length === 0) throw new Error(`Chromium notices are empty: ${source}`);
  const marker = "<!-- CHROMIUM_NOTICES -->";
  if (!reader.includes(marker)) throw new Error("The Chromium notices reader is missing its payload marker.");
  const compressed = await promisify(gzip)(notices, { level: 9 });
  const destination = join(resources, name);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, reader.replace(marker, compressed.toString("base64")));
  await rename(temporary, destination);
  if (source !== destination) await rm(source);
};

export default {
  appId: "app.cerium.desktop",
  productName: "Cerium",
  // The Mac's About panel and the Windows executable's details show it; without it they name no one.
  copyright: "Copyright © CeriumHQ",
  // Electron names the user-data folder after the packaged package.json's productName; the installer
  // names its own folders after `name`, which mustn't be the workspace's scoped name.
  extraMetadata: {
    name: "cerium",
    productName: "Cerium",
    // On Linux, Electron names the window (its Wayland app id and X11 class) and the launcher badge's
    // desktop entry after this; the AppImage's entry takes the same name (`syncDesktopName`).
    desktopName: "cerium.desktop",
    homepage: "https://cerium.nonlooped.xyz",
    ...(version === undefined ? {} : { version }),
  },
  // The icon and installer artwork, drawn by scripts/build-icons.mjs.
  directories: { output: "out", buildResources: "build" },
  // The backend's npm packages come along as @cerium/backend's dependencies. Its own code is bundled
  // into dist/backend.mjs, so Cerium's TypeScript packages stay out, and so do the Claude Agent SDK's
  // bundled `claude` binaries: Cerium always runs the user's own.
  //
  // Every file installed is a file an update removes, unpacks and copies again, so what never runs
  // stays out too: the packages' type declarations, source maps and TypeScript sources (Node won't
  // strip types under node_modules), more than half of their files. So does the build tooling
  // @sentry/node depends on for its bundler plugins (`@sentry/node/bundler-plugin/*`), which Cerium
  // never imports: the Sentry CLI and a native JavaScript parser.
  files: [
    "dist/**",
    // The packaged backend imports both packages as ESM from Electron's Node runtime.
    "!**/node_modules/@cursor/sdk/dist/{cjs,bundled}/**",
    "!**/node_modules/drizzle-orm/**/*.cjs",
    "package.json",
    // The tray's icon (background.ts), and the window's on Linux (main.ts); the menu bar's on macOS.
    "build/icon.ico",
    "build/icon.png",
    "build/trayTemplate.png",
    "build/trayTemplate@2x.png",
    { from: "../../packages/store/migrations", to: "migrations" },
    "!node_modules/@cerium/**",
    "!node_modules/@anthropic-ai/claude-agent-sdk-*/**",
    "!node_modules/**/*.{ts,cts,mts,tsx,map}",
    "!node_modules/{@sentry/bundler-plugins,sentry,oxc-parser,@oxc-parser}/**",
  ],
  // main.ts loads the UI from ../../ui/dist beside dist/, which is resources/ui/dist once packaged.
  // Cerium's own Apache-2.0 license goes along, as the license asks of every copy distributed, and so
  // do the notices for the fonts and icons the UI bundles under licenses of their own.
  extraResources: [
    { from: "../ui/dist", to: "ui/dist", filter: ["**/*", "!cerium-dictation-*.wasm"] },
    { from: "../../LICENSE", to: "LICENSE" },
    { from: "../../THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
  ],
  // No asar archive: the Cursor SDK runs ripgrep and its sandbox from node_modules, and finds them by
  // walking up from the backend's script, which an archive would hide.
  asar: false,
  // `cerium://` links open Cerium: the installers register the scheme (Info.plist on macOS, the
  // desktop entry's MIME types on Linux, the registry on Windows).
  protocols: [{ name: "Cerium", schemes: ["cerium"] }],
  // koffi and node-pty (the terminals' pseudoterminals) ship prebuilt for Node-API, so nothing needs
  // rebuilding.
  npmRebuild: false,
  win: { target: "nsis", icon: "build/icon.ico" },
  // The guided installer, not the one-click one: only it shows the welcome and finish pages' artwork.
  nsis: {
    ...(checkOnly ? { differentialPackage: false } : {}),
    artifactName: "Cerium-Setup-${version}-${arch}.${ext}",
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
    installerSidebar: "build/installerSidebar.bmp",
    uninstallerSidebar: "build/installerSidebar.bmp",
    installerHeader: "build/installerHeader.bmp",
  },
  // The Linux release ships a self-updating AppImage.
  linux: {
    target: ["AppImage"],
    icon: "build/icon.png",
    category: "Development",
    executableName: "cerium",
    syncDesktopName: true,
    synopsis: "One thread, every agent",
    description: "Runs Claude Code, Codex, Cursor and OpenCode side by side.",
    maintainer: "CeriumHQ",
  },
  appImage: { artifactName: "Cerium-${version}-${arch}.${ext}" },
  // The disk image is the installer. The updater downloads the ZIP.
  mac: {
    target: ["dmg", "zip"],
    icon: "build/icon-mac.png",
    category: "public.app-category.developer-tools",
    artifactName: "Cerium-${version}-${arch}-mac.${ext}",
    // With a certificate electron-builder finds the identity in it; without, "-" signs ad hoc.
    ...(developerId ? {} : { identity: "-" }),
    // Notarizing needs the hardened runtime, which an ad hoc signature can't have without its
    // libraries failing validation.
    hardenedRuntime: developerId,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    extendInfo: {
      NSMicrophoneUsageDescription:
        "Cerium listens while you dictate a message. The audio never leaves this Mac.",
    },
  },
  dmg: { ...(checkOnly ? { writeUpdateInfo: false } : {}), artifactName: "Cerium-${version}-${arch}.${ext}" },
  afterPack: async (context: AfterPackContext) => {
    const fallback =
      context.electronPlatformName === "darwin"
        ? join(
            context.packager.getMacOsElectronFrameworkResourcesDir(context.appOutDir),
            "en.lproj",
            "locale.pak",
          )
        : join(context.appOutDir, "locales", "en-US.pak");
    const file = statSync(fallback, { throwIfNoEntry: false });
    if (!file?.isFile() || file.size === 0)
      throw new Error(`Chromium's fallback locale is missing: ${fallback}`);
    await compressChromiumNotices(context);
  },
  // The updater reads the platform feed for the stable or nightly channel.
  publish: {
    provider: "github",
    owner: "CeriumHQ",
    repo: "cerium",
    channel: nightly ? "nightly" : "latest",
  },
} satisfies Configuration;
