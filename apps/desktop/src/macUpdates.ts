import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// Squirrel.Mac checks the new app against the running app's signing identity. Ad hoc signatures
// identify just one build, so they can't use Squirrel. Those builds download the release's ZIP,
// verify its hash and bundle, and leave a helper to replace the app after its backend has stopped.
// Developer ID builds keep Squirrel; a read-only installation still offers the disk image.

const exec = promisify(execFile);

/** The repository the releases are published to (electron-builder.ts). */
const RELEASES = "https://github.com/CeriumHQ/cerium/releases/download";

/** Whether `codesign -dv`'s report names a Developer ID certificate. */
export const signedWithDeveloperId = (report: string): boolean =>
  /^Authority=Developer ID Application: /m.test(report);

/** The running app's bundle: execPath is Cerium.app/Contents/MacOS/Cerium. */
export const macBundlePath = () => join(process.execPath, "..", "..", "..");

export type MacUpdateMode = "native" | "adhoc" | "manual";

/** Read-only volumes (including a mounted DMG or App Translocation) need a manual installation. */
export const macUpdateMode = async (bundle: string): Promise<MacUpdateMode> => {
  try {
    const { stderr } = await exec("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
    if (signedWithDeveloperId(stderr)) return "native";
    if (!/^Signature=adhoc$/m.test(stderr)) return "manual";
    await access(dirname(bundle), constants.W_OK);
    return "adhoc";
  } catch {
    return "manual";
  }
};

/** Where `version`'s disk image for this Mac's processor downloads from. */
export const diskImageUrl = (version: string, arch: string = process.arch): string =>
  `${RELEASES}/v${version}/Cerium-${version}-${arch}.dmg`;

export interface MacRelease {
  readonly version: string;
  readonly files: ReadonlyArray<{ readonly url: string; readonly sha512: string; readonly size?: number }>;
}

/** Only the ZIP for the running processor, from the same public release as the checked feed. */
export const macUpdateFile = (release: MacRelease, arch: string = process.arch) => {
  if (!/^\d+\.\d+\.\d+(?:-nightly\.n?\d+)?$/.test(release.version)) {
    throw new Error("The Mac update has an invalid version.");
  }
  const name = `Cerium-${release.version}-${arch}-mac.zip`;
  const file = release.files.find((file) => file.url === name);
  if (file === undefined || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
    throw new Error(`The Mac update is missing ${name} or its SHA-512 checksum.`);
  }
  return { ...file, url: `${RELEASES}/v${release.version}/${name}` };
};

/** Streaming keeps a several-hundred-MB app off the heap. Never extract a partial or corrupt ZIP. */
export const downloadMacUpdate = async (
  release: MacRelease,
  folder: string,
  fetchFile: (url: string) => Promise<Pick<Response, "ok" | "status" | "body">>,
  progress: (percent: number) => void,
): Promise<string> => {
  const file = macUpdateFile(release);
  const archive = join(folder, "update.zip");
  const response = await fetchFile(file.url);
  if (!response.ok || response.body === null) throw new Error(`Mac update download: HTTP ${response.status}`);
  const output = await open(archive, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha512");
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      // FileHandle.write can make partial writes.
      let written = 0;
      while (written < value.length) {
        const result = await output.write(value, written, value.length - written);
        written += result.bytesWritten;
      }
      received += value.length;
      if (file.size !== undefined && file.size > 0) progress(Math.min(99, (received / file.size) * 100));
    }
    if (hash.digest("base64") !== file.sha512 || (file.size !== undefined && received !== file.size)) {
      throw new Error("The Mac update does not match its published SHA-512 checksum or size.");
    }
    progress(100);
    return archive;
  } catch (error) {
    await rm(archive, { force: true });
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await output.close();
  }
};

/** Check the released app without changing its signature or any Gatekeeper settings. */
export const verifyMacBundle = async (bundle: string, version: string, arch: string = process.arch) => {
  const plist = join(bundle, "Contents", "Info.plist");
  const read = async (key: string) =>
    (await exec("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout.trim();
  const [identifier, released, executable] = await Promise.all([
    read("CFBundleIdentifier"),
    read("CFBundleShortVersionString"),
    read("CFBundleExecutable"),
  ]);
  if (identifier !== "app.cerium.desktop" || released !== version || executable !== "Cerium") {
    throw new Error("The Mac update has the wrong app identity, version, or executable.");
  }
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  const { stderr } = await exec("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
  const processor = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : undefined;
  if (
    processor === undefined ||
    !stderr.split("\n").some((line) => line.startsWith("Format=") && line.includes(processor))
  ) {
    throw new Error("The Mac update is for another processor.");
  }
};

// Arguments, never interpolated shell text: parent PID, installed app, work folder, restart, inode.
// Everything is staged on the installation's volume before quitting. Keep the previous app until
// the replacement and (when requested) Launch Services both succeed, restoring it on failure.
export const MAC_INSTALL_SCRIPT = `
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
parent="$1"
target="$2"
work="$3"
restart="$4"
expected_inode="$5"
backup="$work/previous.app"
next="$work/Cerium.app"
moved=0
installed=0
recover() {
  result=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$result" -ne 0 ] && [ "$moved" -eq 1 ]; then
    if [ "$installed" -eq 1 ] && ! mv "$target" "$next"; then
      echo "Restore Cerium manually from $backup"
      exit "$result"
    fi
    if [ ! -e "$target" ] && mv "$backup" "$target"; then
      echo "Restored the previous Cerium after installation failed."
      if [ "$restart" = 1 ]; then open -a "$target" || true; fi
      rm -rf "$work"
    else
      echo "Restore Cerium manually from $backup"
    fi
  fi
  exit "$result"
}
trap recover EXIT
trap 'exit 1' HUP INT TERM
for ((attempt=0; attempt<600; attempt++)); do
  if ! kill -0 "$parent" 2>/dev/null; then break; fi
  sleep 0.2
done
if kill -0 "$parent" 2>/dev/null; then echo "Cerium did not exit; leaving the installed app intact."; exit 1; fi
if [ ! -d "$next" ] || [ -L "$next" ] || [ ! -d "$target" ] || [ -L "$target" ] || [ -e "$backup" ]; then
  echo "The installed or staged app changed; leaving it intact."
  exit 1
fi
read -r actual_inode rest < <(ls -di "$target")
if [ "$actual_inode" != "$expected_inode" ]; then
  echo "Cerium was replaced since this update was prepared; leaving it intact."
  exit 1
fi
mv "$target" "$backup"
moved=1
mv "$next" "$target"
installed=1
if [ "$restart" = 1 ]; then open -a "$target"; fi
echo "Installed Cerium at $target"
trap - EXIT HUP INT TERM
rm -rf "$work"
`;

export interface PreparedMacUpdate {
  readonly bundle: string;
  readonly folder: string;
  readonly installedInode: string;
}

/** Extract beside the installed app, so replacement is a rename rather than a cross-volume copy. */
export const prepareMacUpdate = async (
  bundle: string,
  archive: string,
  version: string,
  runningVersion: string,
): Promise<PreparedMacUpdate> => {
  const installed = await lstat(bundle, { bigint: true });
  const { stdout } = await exec("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(bundle, "Contents", "Info.plist"),
  ]);
  if (!installed.isDirectory() || stdout.trim() !== runningVersion) {
    throw new Error("The installed Mac app changed; restart Cerium before updating.");
  }
  const folder = await mkdtemp(join(dirname(bundle), ".cerium-update-"));
  try {
    await exec("/usr/bin/ditto", ["-x", "-k", archive, folder]);
    const entries = await readdir(folder);
    if (entries.length !== 1 || entries[0] !== "Cerium.app")
      throw new Error("Unexpected Mac update archive contents.");
    await verifyMacBundle(join(folder, "Cerium.app"), version);
    await writeFile(join(folder, "install.sh"), MAC_INSTALL_SCRIPT, { mode: 0o700 });
    return { bundle, folder, installedInode: installed.ino.toString() };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
};

/** A detached system shell survives Electron; no runtime inside the app being replaced is needed. */
export const installMacUpdate = (
  update: PreparedMacUpdate,
  restart: boolean,
  logFile: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const script = join(update.folder, "install.sh");
    if (readFileSync(script, "utf8") !== MAC_INSTALL_SCRIPT) {
      throw new Error("The staged Mac update helper changed; download the update again.");
    }
    const log = openSync(logFile, "a", 0o600);
    try {
      const child = spawn(
        "/bin/bash",
        [
          script,
          String(process.pid),
          update.bundle,
          update.folder,
          restart ? "1" : "0",
          update.installedInode,
        ],
        {
          detached: true,
          cwd: dirname(update.bundle),
          stdio: ["ignore", log, log],
        },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } finally {
      closeSync(log);
    }
  });
