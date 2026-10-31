// The agent-desktop release Cerium runs, pinned like a dependency: each platform's archive is
// fetched from the project's GitHub release the first time computer use is turned on and checked
// against the SHA-256 below (its release's checksums.txt) before anything in it runs. Upgrading means
// changing the version and every hash together, after checking the JSON contract still reads.

export const AGENT_DESKTOP_VERSION = "1.0.2";

/** The JSON envelope contract (`version`) this build reads; a later minor version only adds. */
export const CONTRACT_MAJOR = 2;

interface Release {
  /** The Rust target the archive is built for. */
  readonly target: string;
  readonly sha256: string;
  /** The executable, then the helpers that must sit beside it. */
  readonly files: ReadonlyArray<string>;
}

const RELEASES: Readonly<Record<string, Release>> = {
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19",
    files: ["agent-desktop", "agent-desktop-macos-helper"],
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121",
    files: ["agent-desktop", "agent-desktop-macos-helper"],
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-gnu",
    sha256: "864cb782e0afc8bf0df19622016b24bdbd1a83fc7749f784ee82aa49a7f845eb",
    files: ["agent-desktop", "agent-desktop-linux-clipboard-owner"],
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-gnu",
    sha256: "ad661b7a3fd8f990a769243f4889a240ca0e2c8dab3ef5bddd6019086c71e0b4",
    files: ["agent-desktop", "agent-desktop-linux-clipboard-owner"],
  },
  "win32-arm64": {
    target: "aarch64-pc-windows-msvc",
    sha256: "a0ecd6e17e60a0bcfbb45533a72f2d3a7a73508769588273ef08b0477d2b9687",
    files: ["agent-desktop.exe"],
  },
  "win32-x64": {
    target: "x86_64-pc-windows-msvc",
    sha256: "2186c76e7df197c0e67365e45d36d869f74714c56bb8a73817e2a66f3e18e222",
    files: ["agent-desktop.exe"],
  },
};

export interface PlatformRelease extends Release {
  readonly url: string;
  readonly archive: string;
}

/** The archive for this operating system and processor, or nothing where agent-desktop has none. */
export const releaseFor = (platform: string, arch: string): PlatformRelease | undefined => {
  const release = RELEASES[`${platform}-${arch}`];
  if (release === undefined) return undefined;
  const archive = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${release.target}.tar.gz`;
  return {
    ...release,
    archive,
    url: `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/${archive}`,
  };
};
