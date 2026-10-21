// Lints the GitHub Actions workflows and actions under .github. actionlint checks their syntax and
// expressions, and every `run:` script through shellcheck; zizmor audits them for security, with the
// settings in .github/zizmor.yml. All three are pinned here by version and checksum, downloaded once
// into node_modules/.cache/workflow-linters, and run on Linux and Windows (x64). CI runs this in its
// lint job, where zizmor's online audits, which look the pinned actions up on GitHub, run too: they
// need GH_TOKEN.
//
// Usage: bun run lint:workflows

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Platform = "linux-x64" | "win32-x64";

interface Download {
  readonly url: string;
  readonly sha256: string;
  /** The executable's path inside the archive. */
  readonly binary: string;
}

interface Tool {
  readonly version: string;
  readonly downloads: Readonly<Record<Platform, Download>>;
}

const github = (repository: string, tag: string, asset: string) =>
  `https://github.com/${repository}/releases/download/${tag}/${asset}`;

const tools = {
  actionlint: {
    version: "1.7.12",
    downloads: {
      "linux-x64": {
        url: github("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_linux_amd64.tar.gz"),
        sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
        binary: "actionlint",
      },
      "win32-x64": {
        url: github("rhysd/actionlint", "v1.7.12", "actionlint_1.7.12_windows_amd64.zip"),
        sha256: "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
        binary: "actionlint.exe",
      },
    },
  },
  shellcheck: {
    version: "0.11.0",
    downloads: {
      "linux-x64": {
        url: github("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.linux.x86_64.tar.gz"),
        sha256: "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
        binary: "shellcheck-v0.11.0/shellcheck",
      },
      "win32-x64": {
        url: github("koalaman/shellcheck", "v0.11.0", "shellcheck-v0.11.0.zip"),
        sha256: "8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e",
        binary: "shellcheck.exe",
      },
    },
  },
  zizmor: {
    version: "1.31.1",
    downloads: {
      "linux-x64": {
        url: github("zizmorcore/zizmor", "v1.31.1", "zizmor-x86_64-unknown-linux-gnu.tar.gz"),
        sha256: "d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99",
        binary: "zizmor",
      },
      "win32-x64": {
        url: github("zizmorcore/zizmor", "v1.31.1", "zizmor-x86_64-pc-windows-msvc.zip"),
        sha256: "4de30371c8a3b483aecbcf0dec1fd6a2b6aae65051ca226b4f6527baac6a8c7a",
        binary: "zizmor.exe",
      },
    },
  },
} satisfies Record<string, Tool>;

const root = join(import.meta.dirname, "..");
const cache = join(root, "node_modules", ".cache", "workflow-linters");

const platform = `${process.platform}-${process.arch}`;
if (platform !== "linux-x64" && platform !== "win32-x64") {
  throw new Error(`The workflow linters are pinned for linux-x64 and win32-x64, not ${platform}.`);
}

// Windows' own tar reads zip archives; Git Bash's, which may come first on the PATH, doesn't.
const tar =
  platform === "win32-x64" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/** The tool's executable, downloaded, checked against its checksum and unpacked on first use. */
const install = async (name: keyof typeof tools): Promise<string> => {
  const { version, downloads } = tools[name];
  const { url, sha256, binary } = downloads[platform];
  const folder = join(cache, `${name}-${version}`);
  const executable = join(folder, binary);
  if (existsSync(executable)) return executable;

  console.log(`Downloading ${name} ${version} ...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ${url} failed: ${response.status}.`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== sha256) throw new Error(`${url} has checksum ${actual}, not the pinned ${sha256}.`);

  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const file = join(folder, url.endsWith(".zip") ? "archive.zip" : "archive.tar.gz");
  writeFileSync(file, archive);
  const unpacked = spawnSync(tar, ["-xf", file, "-C", folder], { stdio: "inherit" });
  rmSync(file);
  if (unpacked.status !== 0 || !existsSync(executable)) {
    rmSync(folder, { recursive: true, force: true });
    throw new Error(`Unpacking ${name} ${version} failed.`);
  }
  return executable;
};

const run = (executable: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(executable, args, { cwd: root, stdio: "inherit", env }).status === 0;

const ci = process.env["GITHUB_ACTIONS"] === "true";
const actionlint = await install("actionlint");
const shellcheck = await install("shellcheck");
const zizmor = await install("zizmor");

const linted = run(actionlint, [
  `-shellcheck=${shellcheck}`,
  // In CI each problem is also an annotation on its line.
  ...(ci
    ? [
        "-format",
        "{{range $err := .}}::error file={{$err.Filepath}},line={{$err.Line}},col={{$err.Column}},title=actionlint {{$err.Kind}}::{{$err.Message}}\\n{{end}}",
      ]
    : []),
]);

const token = process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"];
const audited = run(
  zizmor,
  [
    "--config",
    join(".github", "zizmor.yml"),
    ...(token ? [] : ["--offline"]),
    ...(ci ? ["--format", "github"] : []),
    ".github",
  ],
  token ? { ...process.env, GH_TOKEN: token } : process.env,
);

if (linted && audited) {
  console.log(
    `Workflows: actionlint ${tools.actionlint.version} and zizmor ${tools.zizmor.version} found nothing.`,
  );
} else {
  process.exitCode = 1;
}
