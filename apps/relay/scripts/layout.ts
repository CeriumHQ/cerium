// How the relay's assets hold the web UI's builds, as plain functions
// scripts/assets.ts runs and the tests check.

/** One version's web build: its folder, and what its `build.json` says. */
export interface WebBuild {
  readonly folder: string;
  readonly version: string;
  /** The headers its page is served with, its Content-Security-Policy among them. */
  readonly pageHeaders: ReadonlyArray<string>;
}

/** Cloudflare reads at most this many rules from `_headers`. */
const MAX_HEADER_RULES = 100;

const rule = (path: string, headers: ReadonlyArray<string>) =>
  [path, ...headers.map((header) => `  ${header}`)].join("\n");

/** Where the web app opens: the root is the website's. */
export const APP_PATH = "/app/";

/** The public repository the installers are published to (apps/desktop/electron-builder.ts). */
const RELEASES = "https://github.com/CeriumHQ/releases/releases/download";

/** Each download's path under `/download`, and the file it names, as electron-builder names it. */
const downloads = (version: string): ReadonlyArray<readonly [string, string]> => [
  ["", `Cerium-Setup-${version}-x64.exe`],
  ["/windows-arm64", `Cerium-Setup-${version}-arm64.exe`],
  ["/linux", `Cerium-${version}-x86_64.AppImage`],
  ["/linux-arm64", `Cerium-${version}-arm64.AppImage`],
  ["/deb", `cerium_${version}_amd64.deb`],
  ["/deb-arm64", `cerium_${version}_arm64.deb`],
  ["/rpm", `cerium-${version}.x86_64.rpm`],
  ["/rpm-arm64", `cerium-${version}.aarch64.rpm`],
];

/**
 * The relay's `_redirects`: `/download` fetches the Windows installer of the version deployed with
 * it, and the paths below it the Arm64 installer and each Linux package, which the release workflows
 * publish alongside (apps/desktop/electron-builder.ts).
 */
export const redirects = (root: WebBuild | undefined): string => {
  if (root === undefined) return "";
  const release = `${RELEASES}/v${root.version}`;
  return [
    ...downloads(root.version).map(([path, file]) => `/download${path} ${release}/${file} 302`),
    "",
  ].join("\n");
};

/**
 * The builds the relay serves and its `_headers`. `root`, this checkout's build, is served at
 * `APP_PATH` too and wins over an earlier build of its version. Each page gets its own build's
 * policy: Cloudflare joins the values of every rule a path matches, and two policies would only admit
 * what both do.
 */
export const layOut = (
  root: WebBuild | undefined,
  earlier: ReadonlyArray<WebBuild>,
  relayHeaders: string,
): { readonly builds: ReadonlyArray<WebBuild>; readonly headers: string } => {
  const byVersion = new Map(earlier.map((build) => [build.version, build]));
  if (root !== undefined) byVersion.set(root.version, root);
  const builds = [...byVersion.values()];
  const rules = [
    ...(root === undefined
      ? []
      : [APP_PATH, `${APP_PATH}index.html`].map((path) => rule(path, root.pageHeaders))),
    ...builds.flatMap((build) =>
      [`/v/${build.version}/`, `/v/${build.version}/index.html`].map((path) => rule(path, build.pageHeaders)),
    ),
    // Browsers check for a newer worker at each visit, and for newer builds at each start.
    rule("/sw.js", ["Cache-Control: no-cache"]),
    rule("/v/builds.json", ["Cache-Control: no-cache"]),
  ];
  const own = relayHeaders.trim();
  const count = rules.length + (own.match(/^\S/gm)?.length ?? 0);
  if (count > MAX_HEADER_RULES) {
    throw new Error(
      `${count} header rules are more than Cloudflare reads (${MAX_HEADER_RULES}): keep fewer builds.`,
    );
  }
  return { builds, headers: `${[...rules, ...(own === "" ? [] : [own])].join("\n\n")}\n` };
};
