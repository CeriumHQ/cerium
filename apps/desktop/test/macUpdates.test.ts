import { afterEach, describe, expect, it } from "@effect/vitest";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import {
  downloadMacUpdate,
  MAC_INSTALL_SCRIPT,
  macUpdateFile,
  macUpdateMode,
  prepareMacUpdate,
  signedWithDeveloperId,
  verifyMacBundle,
} from "../src/macUpdates.ts";

const exec = promisify(execFile);
const folders: string[] = [];
const temporary = async () => {
  const folder = await mkdtemp(join(tmpdir(), "cerium-mac-update-test-"));
  folders.push(folder);
  return folder;
};
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const release = (payload: string, version = "1.2.3") => ({
  version,
  files: [
    {
      url: `Cerium-${version}-${process.arch}-mac.zip`,
      sha512: createHash("sha512").update(payload).digest("base64"),
      size: Buffer.byteLength(payload),
    },
  ],
});

describe("signedWithDeveloperId", () => {
  it("takes a Developer ID signature, and nothing signed ad hoc or for development", () => {
    const developerId = [
      "Executable=/Applications/Cerium.app/Contents/MacOS/Cerium",
      "Authority=Developer ID Application: Cerium (ABCDE12345)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=ABCDE12345",
    ].join("\n");
    const adHoc = ["Executable=/Applications/Cerium.app/Contents/MacOS/Cerium", "Signature=adhoc"].join("\n");
    const development = "Authority=Apple Development: someone@example.com (XYZ)";
    expect(signedWithDeveloperId(developerId)).toBe(true);
    expect(signedWithDeveloperId(adHoc)).toBe(false);
    expect(signedWithDeveloperId(development)).toBe(false);
    expect(signedWithDeveloperId("")).toBe(false);
  });
});

describe("Mac release downloads", () => {
  it("selects the current processor's ZIP and builds the public release URL", () => {
    const info = release("zip", "1.2.3-nightly.n000123");
    expect(macUpdateFile(info).url).toBe(
      `https://github.com/CeriumHQ/cerium/releases/download/v${info.version}/${info.files[0]!.url}`,
    );
    expect(() => macUpdateFile(info, process.arch === "arm64" ? "x64" : "arm64")).toThrow("missing");
    expect(() => macUpdateFile({ ...info, version: "../../other" })).toThrow("invalid version");
    expect(() => macUpdateFile({ ...info, files: [{ ...info.files[0]!, sha512: "" }] })).toThrow("checksum");
    expect(() =>
      macUpdateFile({ ...info, files: [{ ...info.files[0]!, url: "https://other.example/update.zip" }] }),
    ).toThrow("missing");
  });

  it("saves a verified download and reports completion", async () => {
    const folder = await temporary();
    const payload = "a downloaded archive";
    const progress: number[] = [];
    const archive = await downloadMacUpdate(
      release(payload),
      folder,
      async () => new Response(payload),
      (value) => progress.push(value),
    );
    expect(await readFile(archive, "utf8")).toBe(payload);
    expect(progress.at(-1)).toBe(100);
  });

  it("removes corrupt, truncated, and empty downloads", async () => {
    for (const payload of ["modified", "truncated download"]) {
      const folder = await temporary();
      await expect(
        downloadMacUpdate(
          release("original"),
          folder,
          async () => new Response(payload),
          () => undefined,
        ),
      ).rejects.toThrow("checksum");
      expect(await readdir(folder)).toEqual([]);
    }
    const folder = await temporary();
    const response = new Response("body");
    const reader = response.body!.getReader();
    await reader.cancel();
    reader.releaseLock();
    await expect(
      downloadMacUpdate(
        release("body"),
        folder,
        async () => response,
        () => undefined,
      ),
    ).rejects.toThrow("checksum");
    expect(await readdir(folder)).toEqual([]);
  });

  it("does not create an archive for an HTTP error", async () => {
    const folder = await temporary();
    await expect(
      downloadMacUpdate(
        release("body"),
        folder,
        async () => new Response(null, { status: 404 }),
        () => undefined,
      ),
    ).rejects.toThrow("HTTP 404");
    expect(await readdir(folder)).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("Mac replacement helper", () => {
  const fixture = async () => {
    const folder = await temporary();
    // Spaces and shell metacharacters must reach commands as literal paths.
    const bundle = join(folder, "Cerium $literal ' app.app");
    const work = join(folder, ".cerium-update-test");
    await mkdir(bundle);
    await mkdir(join(work, "Cerium.app"), { recursive: true });
    await writeFile(join(bundle, "version"), "old");
    await writeFile(join(work, "Cerium.app", "version"), "new");
    return { folder, bundle, work };
  };
  const install = async (
    bundle: string,
    work: string,
    restart = false,
    prefix = "",
    parent = "2147483647",
    inode?: string,
  ) =>
    exec("/bin/bash", [
      "-c",
      `${prefix}\n${MAC_INSTALL_SCRIPT}`,
      "cerium-update",
      parent,
      bundle,
      work,
      restart ? "1" : "0",
      inode ?? (await lstat(bundle, { bigint: true })).ino.toString(),
    ]);

  it("replaces the app on quit and cleans the staging folder", async () => {
    const { bundle, work } = await fixture();
    await install(bundle, work);
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("new");
    await expect(access(work)).rejects.toThrow("ENOENT");
  });

  it("waits for the old process to exit before touching its bundle", async () => {
    const { bundle, work } = await fixture();
    const parent = spawn("/bin/sleep", ["0.5"]);
    const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    const installed = install(bundle, work, false, "", String(parent.pid));
    await setTimeout(80);
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("old");
    await exited;
    await installed;
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("new");
  });

  it("opens the replacement only when a restart was requested", async () => {
    const { bundle, work } = await fixture();
    const { stdout } = await install(bundle, work, true, 'open() { echo "launched:$2"; }');
    expect(stdout).toContain(`launched:${bundle}`);
  });

  it("restores the old app if moving the replacement fails", async () => {
    const { bundle, work } = await fixture();
    await expect(
      install(bundle, work, false, 'mv() { if [ "$1" = "$next" ]; then return 42; fi; command mv "$@"; }'),
    ).rejects.toThrow("Command failed");
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("old");
    await expect(access(work)).rejects.toThrow("ENOENT");
  });

  it("restores the old app if Launch Services rejects the replacement", async () => {
    const { bundle, work } = await fixture();
    await expect(install(bundle, work, true, "open() { return 43; }")).rejects.toThrow("Command failed");
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("old");
  });

  it("leaves the old app intact when staging disappeared", async () => {
    const { bundle, work } = await fixture();
    await rm(join(work, "Cerium.app"), { recursive: true });
    await expect(install(bundle, work)).rejects.toThrow("staged app changed");
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("old");
  });

  it("does not overwrite a manually replaced app", async () => {
    const { bundle, work } = await fixture();
    const inode = (await lstat(bundle, { bigint: true })).ino.toString();
    await rename(bundle, `${bundle}.previous`);
    await mkdir(bundle);
    await writeFile(join(bundle, "version"), "manually installed");
    await expect(install(bundle, work, false, "", "2147483647", inode)).rejects.toThrow("replaced since");
    expect(await readFile(join(bundle, "version"), "utf8")).toBe("manually installed");
  });
});

describe.skipIf(process.platform !== "darwin")("Mac bundle verification and staging", () => {
  const signedApp = async () => {
    const folder = await temporary();
    const bundle = join(folder, "Cerium.app");
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    const source = join(folder, "main.c");
    await writeFile(source, "int main(void) { return 0; }\n");
    await exec("/usr/bin/cc", [source, "-o", join(bundle, "Contents", "MacOS", "Cerium")]);
    await writeFile(
      join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>app.cerium.desktop</string>
      <key>CFBundleShortVersionString</key><string>1.2.3</string>
      <key>CFBundleExecutable</key><string>Cerium</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      </dict></plist>`,
    );
    await exec("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
    return { folder, bundle };
  };

  it("accepts a valid ad hoc app and rejects the wrong version, processor, or tampered resources", async () => {
    const { bundle } = await signedApp();
    expect(await macUpdateMode(bundle)).toBe("adhoc");
    await verifyMacBundle(bundle, "1.2.3");
    await expect(verifyMacBundle(bundle, "1.2.4")).rejects.toThrow("version");
    await expect(
      verifyMacBundle(bundle, "1.2.3", process.arch === "arm64" ? "x64" : "arm64"),
    ).rejects.toThrow("processor");
    await writeFile(join(bundle, "Contents", "injected-resource"), "tampered");
    await expect(verifyMacBundle(bundle, "1.2.3")).rejects.toThrow("Command failed");
  });

  it("stages a verified ZIP on the installation's volume without changing the installed app", async () => {
    const { folder, bundle } = await signedApp();
    const archive = join(folder, "update.zip");
    await exec("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
    const prepared = await prepareMacUpdate(bundle, archive, "1.2.3", "1.2.3");
    expect(prepared.folder.startsWith(join(folder, ".cerium-update-"))).toBe(true);
    await verifyMacBundle(join(prepared.folder, "Cerium.app"), "1.2.3");
    await verifyMacBundle(bundle, "1.2.3");
    expect(await readFile(join(prepared.folder, "install.sh"), "utf8")).toBe(MAC_INSTALL_SCRIPT);
  });

  it("removes staging and leaves the installed app alone when validation fails", async () => {
    const { folder, bundle } = await signedApp();
    const archive = join(folder, "update.zip");
    await exec("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
    await expect(prepareMacUpdate(bundle, archive, "9.9.9", "1.2.3")).rejects.toThrow("version");
    await expect(prepareMacUpdate(bundle, archive, "1.2.3", "0.0.0")).rejects.toThrow(
      "installed Mac app changed",
    );
    expect((await readdir(folder)).filter((name) => name.startsWith(".cerium-update-"))).toEqual([]);
    await verifyMacBundle(bundle, "1.2.3");
  });

  it("runs the detached installer after the process that started it exits", async () => {
    const { folder, bundle } = await signedApp();
    const archive = join(folder, "update.zip");
    await exec("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
    const prepared = await prepareMacUpdate(bundle, archive, "1.2.3", "1.2.3");
    const log = join(folder, "updater.log");
    await exec(process.execPath, [
      "--input-type=module",
      "-e",
      `
      const { installMacUpdate } = await import(process.argv[1]);
      await installMacUpdate(JSON.parse(process.argv[2]), false, process.argv[3]);
    `,
      new URL("../src/macUpdates.ts", import.meta.url).href,
      JSON.stringify(prepared),
      log,
    ]);
    await expect
      .poll(
        async () => {
          try {
            await access(prepared.folder);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(await readFile(log, "utf8")).toContain(`Installed Cerium at ${bundle}`);
    await verifyMacBundle(bundle, "1.2.3");
  });
});
