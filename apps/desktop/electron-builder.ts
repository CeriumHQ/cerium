import type { Configuration } from "electron-builder";

// Packages the desktop shell and its backend for the platform it runs on: an unsigned installer on
// Windows, an AppImage on Linux. The release workflows set CERIUM_VERSION from scripts/release.ts;
// without it this builds at the package's own version. Stable and nightly builds are the same app: a nightly's version
// (`-nightly.n<run>`) is all that tells them apart, and the updater follows whichever channel the
// user picks.

const version = process.env["CERIUM_VERSION"];
const nightly = version?.includes("-nightly.") === true;

export default {
  appId: "app.cerium.desktop",
  productName: "Cerium",
  // Electron names the user-data folder after the packaged package.json's productName; the installer
  // names its own folders after `name`, which mustn't be the workspace's scoped name.
  extraMetadata: {
    name: "cerium",
    productName: "Cerium",
    // On Linux, Electron names the window (its Wayland app id and X11 class) and the launcher badge's
    // desktop entry after this; the AppImage's entry takes the same name (`syncDesktopName`).
    desktopName: "cerium.desktop",
    ...(version === undefined ? {} : { version }),
  },
  // The icon and installer artwork, drawn by scripts/build-icons.mjs.
  directories: { output: "out", buildResources: "build" },
  // The backend's npm packages come along as @cerium/backend's dependencies. Its own code is bundled
  // into dist/backend.mjs, so Cerium's TypeScript packages stay out, and so do the Claude Agent SDK's
  // bundled `claude` binaries: Cerium always runs the user's own.
  files: [
    "dist/**",
    "package.json",
    // The tray's icon (background.ts), and the window's on Linux (main.ts).
    "build/icon.ico",
    "build/icon.png",
    { from: "../../packages/store/migrations", to: "migrations" },
    "!node_modules/@cerium/**",
    "!node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  // main.ts loads the UI from ../../ui/dist beside dist/, which is resources/ui/dist once packaged.
  extraResources: [{ from: "../ui/dist", to: "ui/dist" }],
  // No asar archive: the Cursor SDK runs ripgrep and its sandbox from node_modules, and finds them by
  // walking up from the backend's script, which an archive would hide.
  asar: false,
  // koffi and node-pty (the terminals' pseudoterminals) ship prebuilt for Node-API, so nothing needs
  // rebuilding.
  npmRebuild: false,
  win: { target: "nsis", icon: "build/icon.ico" },
  // The guided installer, not the one-click one: only it shows the welcome and finish pages' artwork.
  nsis: {
    artifactName: "Cerium-Setup-${version}.${ext}",
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    installerHeaderIcon: "build/icon.ico",
    installerSidebar: "build/installerSidebar.bmp",
    uninstallerSidebar: "build/installerSidebar.bmp",
    installerHeader: "build/installerHeader.bmp",
  },
  // One AppImage runs on every distribution, and updates itself in place (src/updater.ts). Its
  // desktop entry is what launchers and docks know Cerium by.
  linux: {
    target: "AppImage",
    icon: "build/icon.png",
    category: "Development",
    executableName: "cerium",
    syncDesktopName: true,
    synopsis: "One thread, every agent",
    description: "Runs Claude Code, Codex, Cursor and OpenCode side by side.",
  },
  appImage: { artifactName: "Cerium-${version}-${arch}.${ext}" },
  // The update feed (src/updater.ts). Packaging never uploads (`--publish never`); it writes the
  // channel's update file beside the installer, latest.yml or nightly.yml (latest-linux.yml or
  // nightly-linux.yml beside an AppImage), and the release workflows publish it with the installer
  // and its blockmap. The source repository is private, so the app
  // reads a public repository that holds only releases (.github/actions/publish-feed).
  publish: {
    provider: "github",
    owner: "CeriumHQ",
    repo: "cerium-releases",
    channel: nightly ? "nightly" : "latest",
  },
} satisfies Configuration;
