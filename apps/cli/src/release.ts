export const targets = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "win32-arm64",
] as const;
export type Target = (typeof targets)[number];

export function target(value: string): Target {
  const found = targets.find((item) => item === value);
  if (!found) throw new Error(`Unsupported host target "${value}".`);
  return found;
}

const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.n?(\d+))?$/;
export function releaseVersion(input: string) {
  const value = input.replace(/^v/, "");
  if (!pattern.test(value)) throw new Error(`Invalid Cerium release version "${input}".`);
  return value;
}

export function compareVersions(a: string, b: string) {
  const parts = (v: string) =>
    pattern
      .exec(releaseVersion(v))!
      .slice(1)
      .map((s) => (s === undefined ? Infinity : Number(s)));
  const left = parts(a),
    right = parts(b);
  for (const [i, part] of left.entries()) {
    if (part !== right[i]) return part > right[i]! ? 1 : -1;
  }
  return 0;
}

export const layoutName = (version: string, platform: Target) =>
  `cerium-host-${releaseVersion(version)}-${platform}`;
export const archiveName = (version: string, platform: Target) =>
  layoutName(version, platform) + (platform.startsWith("win32-") ? ".zip" : ".tar.gz");
