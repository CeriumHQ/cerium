import { readFileSync } from "node:fs";
import { join } from "node:path";

// How Cerium was installed on Linux, which decides how it updates and what starts it at login. An
// AppImage's runtime names the file in APPIMAGE; a .deb or .rpm package installs to /opt/Cerium, and
// electron-builder writes the package's kind to resources/package-type, which electron-updater also
// reads to pick the updater that installs the next package with the system's package manager.

export type LinuxInstall =
  | { readonly kind: "appimage"; readonly program: string }
  | { readonly kind: "deb" | "rpm"; readonly program: string };

/** The install `appImage`, `packageType` and `execPath` describe, or none for a development build. */
export const linuxInstallFrom = (
  appImage: string | undefined,
  packageType: string | undefined,
  execPath: string,
): LinuxInstall | undefined => {
  if (appImage) return { kind: "appimage", program: appImage };
  const kind = packageType?.trim();
  return kind === "deb" || kind === "rpm" ? { kind, program: execPath } : undefined;
};

const readPackageType = (): string | undefined => {
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8");
  } catch {
    return undefined;
  }
};

/** This process's install; only meaningful in the packaged app on Linux. */
export const linuxInstall = (): LinuxInstall | undefined =>
  linuxInstallFrom(process.env["APPIMAGE"], readPackageType(), process.execPath);
