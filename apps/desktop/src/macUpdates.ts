import { execFile } from "node:child_process";
import { join } from "node:path";

// How the Mac app updates. electron-updater hands the new build to Squirrel.Mac, which installs it
// only when both carry the same Developer ID signature; a build signed ad hoc (released without
// Apple's certificate) can't pass that check, so it offers the new version's disk image in the
// browser instead, to drag into Applications.

/** The repository the releases are published to (electron-builder.ts). */
const RELEASES = "https://github.com/CeriumHQ/cerium/releases/download";

/** Whether `codesign -dv`'s report names a Developer ID certificate. */
export const signedWithDeveloperId = (report: string): boolean =>
  /^Authority=Developer ID Application: /m.test(report);

/** The running app's bundle: execPath is Cerium.app/Contents/MacOS/Cerium. */
const bundlePath = () => join(process.execPath, "..", "..", "..");

/** Whether this Mac build can install its updates itself; false when codesign can't say. */
export const updatesInPlace = (): Promise<boolean> =>
  new Promise((resolve) => {
    // codesign writes its report to stderr.
    execFile("codesign", ["-dv", "--verbose=2", bundlePath()], { encoding: "utf8" }, (_error, _out, report) =>
      resolve(signedWithDeveloperId(report ?? "")),
    );
  });

/** Where `version`'s disk image for this Mac's processor downloads from. */
export const diskImageUrl = (version: string, arch: string = process.arch): string =>
  `${RELEASES}/v${version}/Cerium-${version}-${arch}.dmg`;
