import type { Configuration } from "electron-builder";

// Packages the desktop shell and its backend for the platform and processor it runs on: an unsigned
// installer on Windows, an AppImage, a .deb and an .rpm on Linux, a disk image on macOS, each for x64
// or Arm64. Each
// processor packages on its own runner, since the native modules' prebuilt binaries come from npm
// packages Bun installs only for the processor it runs on. The release workflows set CERIUM_VERSION
// from scripts/release.ts; without it this builds at the package's own version. Stable and nightly
// builds are the same app: a nightly's version (`-nightly.n<run>`) is all that tells them apart, and
// the updater follows whichever channel the user picks.

const version = process.env["CERIUM_VERSION"];
const nightly = version?.includes("-nightly.") === true;
/**
 * A Developer ID certificate to sign the Mac app with (CSC_LINK, set by the release workflows when
 * the repository has one), which also has it notarized when APPLE_API_KEY and its ID and issuer are
 * set. Without one the app is signed ad hoc: it runs on Apple silicon, the user lets it open once in
 * Privacy & Security, and updates download in the browser (src/macUpdates.ts).
 */
const developerId = Boolean(process.env["CSC_LINK"] || process.env["CSC_NAME"]);
/**
 * Packed fast, for nightlies and runs that only check the packaging (.github/actions/package).
 * electron-builder applies ELECTRON_BUILDER_COMPRESSION_LEVEL to its 7z archives and disk images
 * only, so the .deb and .rpm, which it otherwise packs with xz, take gzip here: a few times faster,
 * somewhat larger, and installed the same way.
 */
const fastPacking = process.env["ELECTRON_BUILDER_COMPRESSION_LEVEL"] !== undefined;

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
    // The .deb and .rpm packages name it as their project's page.
    homepage: "https://cerium.nonlooped.xyz",
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
    // The tray's icon (background.ts), and the window's on Linux (main.ts); the menu bar's on macOS.
    "build/icon.ico",
    "build/icon.png",
    "build/trayTemplate.png",
    "build/trayTemplate@2x.png",
    { from: "../../packages/store/migrations", to: "migrations" },
    "!node_modules/@cerium/**",
    "!node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  // main.ts loads the UI from ../../ui/dist beside dist/, which is resources/ui/dist once packaged.
  // Cerium's own Apache-2.0 license goes along, as the license asks of every copy distributed.
  extraResources: [
    { from: "../ui/dist", to: "ui/dist" },
    { from: "../../LICENSE", to: "LICENSE" },
  ],
  // No asar archive: the Cursor SDK runs ripgrep and its sandbox from node_modules, and finds them by
  // walking up from the backend's script, which an archive would hide.
  asar: false,
  // koffi and node-pty (the terminals' pseudoterminals) ship prebuilt for Node-API, so nothing needs
  // rebuilding.
  npmRebuild: false,
  win: { target: "nsis", icon: "build/icon.ico" },
  // The guided installer, not the one-click one: only it shows the welcome and finish pages' artwork.
  // Its name carries the processor: the x64 and Arm64 installers share one latest.yml
  // (scripts/merge-update-files.ts), from which electron-updater picks the file naming its own.
  nsis: {
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
  // One AppImage runs on every distribution and updates itself in place; the .deb (Ubuntu, Debian)
  // and .rpm (Fedora, RHEL) install to /opt/Cerium with the system's package manager, which also
  // installs their updates (src/updater.ts). Their desktop entry is what launchers and docks know
  // Cerium by, and their install script sets Chromium's sandbox up, with an AppArmor profile on
  // Ubuntu 24.04 and later.
  linux: {
    target: ["AppImage", "deb", "rpm"],
    icon: "build/icon.png",
    category: "Development",
    executableName: "cerium",
    syncDesktopName: true,
    synopsis: "One thread, every agent",
    description: "Runs Claude Code, Codex, Cursor and OpenCode side by side.",
    maintainer: "CeriumHQ",
  },
  appImage: { artifactName: "Cerium-${version}-${arch}.${ext}" },
  // Named the way each system's own packages are: cerium_1.2.0_amd64.deb, cerium-1.2.0.x86_64.rpm,
  // which the relay's download links name too (apps/relay/scripts/layout.ts). Their dependencies are
  // electron-builder's own, with the sound and GPU buffer libraries Electron also links against,
  // which a minimal install lacks.
  deb: {
    artifactName: "cerium_${version}_${arch}.${ext}",
    packageCategory: "devel",
    ...(fastPacking ? { compression: "gz" } : {}),
    depends: [
      ...["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0"],
      ...["libuuid1", "libsecret-1-0", "libasound2", "libgbm1"],
    ],
  },
  // Every Electron app ships the same Chromium libraries, and Fedora's rpm links each binary's build
  // id under /usr/lib/.build-id, where two such apps would claim the same link and refuse to install
  // side by side.
  rpm: {
    artifactName: "cerium-${version}.${arch}.${ext}",
    fpm: ["--rpm-rpmbuild-define=_build_id_links none"],
    ...(fastPacking ? { compression: "gzip" } : {}),
    depends: [
      ...["gtk3", "libnotify", "nss", "libXScrnSaver", "(libXtst or libXtst6)", "xdg-utils", "at-spi2-core"],
      ...["(libuuid or libuuid1)", "(alsa-lib or libasound2)", "(mesa-libgbm or libgbm1)"],
    ],
  },
  // A disk image to drag the app into Applications from, and the zip electron-updater installs
  // updates from, each for the processor of the Mac it is built on: Apple silicon (arm64) or Intel
  // (x64). Both processors' zips share one latest-mac.yml (scripts/merge-update-files.ts), from which
  // electron-updater picks the one naming its own.
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
  dmg: { artifactName: "Cerium-${version}-${arch}.${ext}" },
  // The update feed (src/updater.ts). Packaging never uploads (`--publish never`); it writes the
  // channel's update file beside the installer, latest.yml or nightly.yml (latest-linux.yml or
  // nightly-linux.yml beside the Linux packages, latest-linux-arm64.yml beside Arm64's,
  // latest-mac.yml or nightly-mac.yml beside the Mac's), and the
  // release workflows publish it with the installer and its blockmap to this repository's releases.
  publish: {
    provider: "github",
    owner: "CeriumHQ",
    repo: "cerium",
    channel: nightly ? "nightly" : "latest",
  },
} satisfies Configuration;
