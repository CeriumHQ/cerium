import type { CapabilityManifest, VersionStatus } from "@cerium/protocol";

/** Extracts the first `major.minor.patch` from free-form CLI output such as "2.1.301 (Claude Code)". */
export const parseVersion = (text: string): string | undefined => /\d+\.\d+\.\d+/.exec(text)?.[0];

const parts = (version: string): ReadonlyArray<number> =>
  version.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10) || 0);

/** Numeric `major.minor.patch` comparison; pre-release suffixes are ignored. */
export const compareVersions = (a: string, b: string): number => {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

export const classifyVersion = (
  installed: string,
  range: CapabilityManifest["harnessVersion"],
): VersionStatus => {
  if (compareVersions(installed, range.minimum) < 0) return "tooOld";
  if (compareVersions(installed, range.testedMaximum) > 0) return "untested";
  return "supported";
};
