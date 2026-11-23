import { execFileSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { archiveName, layoutName, releaseVersion, target, type Target } from "../src/release.ts";
import { checksum, download, extract, sha256, systemTar } from "../src/download.ts";
import { assertPtyPatch, keepDependency, nodeVersion, root, stage } from "./stage.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    target: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.target || !values.version || !values.out)
  throw new Error("Specify --target, --version and --out.");
const platform = target(values.target),
  version = releaseVersion(values.version);
const output = resolve(values.out);
const work = await mkdtemp(join(tmpdir(), "cerium-package-"));
const name = layoutName(version, platform),
  directory = join(work, name);
const windows = platform.startsWith("win32-");

async function stageRuntime() {
  const runtime = join(directory, "runtime");
  const node = join(runtime, windows ? "node.exe" : "bin/node");
  await mkdir(dirname(node), { recursive: true });
  const installed = dirname(windows ? process.execPath : dirname(process.execPath));
  if (
    process.version === "v" + nodeVersion &&
    platform === `${process.platform}-${process.arch}` &&
    existsSync(join(installed, "LICENSE"))
  ) {
    await copyFile(process.execPath, node);
    await copyFile(join(installed, "LICENSE"), join(runtime, "LICENSE"));
  } else {
    const dist = "node-v" + nodeVersion + "-" + platform.replace("win32-", "win-");
    const asset = dist + (windows ? ".zip" : platform.startsWith("darwin-") ? ".tar.gz" : ".tar.xz");
    const url = "https://nodejs.org/dist/v" + nodeVersion;
    const sums = join(work, "SHASUMS256.txt"),
      archive = join(work, asset);
    await Promise.all([download(url + "/SHASUMS256.txt", sums), download(url + "/" + asset, archive)]);
    if ((await sha256(archive)) !== checksum(await readFile(sums, "utf8"), asset))
      throw new Error(`Node runtime checksum failed for ${asset}.`);
    extract(archive, work);
    await copyFile(join(work, dist, windows ? "node.exe" : "bin/node"), node);
    await copyFile(join(work, dist, "LICENSE"), join(runtime, "LICENSE"));
  }
  await chmod(node, 0o755);
}

async function stageDependencies(destination: string, buildTarget: Target) {
  // Recreate just the workspace manifests in a temporary checkout. Bun can then install the
  // release target's production closure from the same frozen lock and patches as the desktop.
  const workspace = join(work, "workspace"),
    repo = resolve(root, "../..");
  await mkdir(workspace);
  for (const file of ["bun.lock", "bunfig.toml", "package.json", "patches"])
    await cp(join(repo, file), join(workspace, file), { recursive: true });
  const { glob } = await import("node:fs/promises");
  for await (const file of glob(
    ["apps/*/package.json", "packages/*/package.json", "packages/adapters/*/package.json"],
    { cwd: repo },
  )) {
    await mkdir(dirname(join(workspace, file)), { recursive: true });
    await copyFile(join(repo, file), join(workspace, file));
  }
  const [os, arch] = buildTarget.split("-");
  execFileSync(
    "bun",
    [
      "install",
      "--production",
      "--ignore-scripts",
      "--frozen-lockfile",
      "--linker=hoisted",
      "--filter",
      "@cerium/host",
      "--os=" + os,
      "--cpu=" + arch,
    ],
    { cwd: workspace, stdio: "inherit" },
  );
  const modules = join(workspace, "node_modules");
  await cp(modules, join(destination, "node_modules"), {
    recursive: true,
    filter: (path) => {
      const relative = path.slice(modules.length + 1).split(/[\\/]/);
      return relative[0] !== "@cerium" && !relative.includes(".bun") && keepDependency(path, buildTarget);
    },
  });
  await assertPtyPatch(destination);
}

try {
  await stage(directory, version);
  await stageRuntime();
  await stageDependencies(directory, platform);
  const launcher = windows ? "cerium-host.cmd" : "cerium-host";
  for (const file of ["standalone.mjs", launcher])
    await copyFile(join(root, "bin", file), join(directory, "bin", file));
  await chmod(join(directory, "bin", launcher), 0o755);
  await mkdir(output, { recursive: true });
  const archive = join(output, archiveName(version, platform));
  await rm(archive, { force: true });
  if (windows && process.platform !== "win32") execFileSync("zip", ["-qr", archive, name], { cwd: work });
  else execFileSync(systemTar, [windows ? "-acf" : "-czf", archive, "-C", work, name], { stdio: "inherit" });
  await writeFile(archive + ".sha256", (await sha256(archive)) + "  " + basename(archive) + "\n");
  console.log(archive);
} finally {
  await rm(work, { recursive: true, force: true });
}
