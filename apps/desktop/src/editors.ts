import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";

// Opening a file at a line in the user's editor: which ones are installed, and each one's own way to
// jump to a line. Nothing runs through a shell (Windows' `.cmd` launchers would need one, and a path
// with `&` in it would then run as a command), so each editor is started through its executable.

/** An editor Cerium can open a file in: the id the UI keeps as the user's choice, and its name. */
export interface Editor {
  readonly id: string;
  readonly label: string;
}

/** An editor found on this machine and the program that starts it. */
export interface FoundEditor extends Editor {
  readonly program: string;
}

type Platform = "win32" | "darwin" | "linux";

/** How each family of editors is told which file, folder and line to open. */
type Style = "vscode" | "zed" | "jetbrains" | "visualStudio";

/** What the editor's args need to know about the thing to open. */
export interface Target {
  readonly file: string;
  /** From 1; absent opens the file at its top. */
  readonly line?: number | undefined;
  /** The project's folder, so the editor opens the file in that project's window. */
  readonly folder?: string | undefined;
}

/**
 * The arguments that open `target` in an editor of `style`: VS Code's family takes `-g file:line`, Zed
 * `file:line`, JetBrains IDEs `--line N file`, and Visual Studio `/Edit file` with the Go To command
 * run once the file is open. A folder goes first, where the editor takes one.
 */
export const editorArgs = (style: Style, { file, line, folder }: Target): ReadonlyArray<string> => {
  switch (style) {
    case "vscode":
      return [...(folder ? [folder] : []), "-g", line === undefined ? file : `${file}:${line}`];
    case "zed":
      return [...(folder ? [folder] : []), line === undefined ? file : `${file}:${line}`];
    case "jetbrains":
      return [...(folder ? [folder] : []), ...(line === undefined ? [] : ["--line", String(line)]), file];
    case "visualStudio":
      return ["/Edit", file, ...(line === undefined ? [] : ["/Command", `Edit.GoTo ${line}`])];
  }
};

interface Family {
  readonly id: string;
  readonly label: string;
  readonly style: Style;
  /** Where its program lives, by platform; `PATH` entries are looked up by file name. */
  readonly locations: (platform: Platform, env: Env) => ReadonlyArray<string>;
}

type Env = Readonly<Record<string, string | undefined>>;

const programFiles = (env: Env): ReadonlyArray<string> =>
  [env["ProgramFiles"], env["ProgramFiles(x86)"], env["ProgramW6432"]].filter(
    (each): each is string => each !== undefined && each !== "",
  );

/** VS Code's family (VS Code, Cursor) installs the same way: an executable beside a `bin` of launchers. */
const vscodeFamily = (
  id: string,
  label: string,
  windows: { readonly folder: string; readonly exe: string },
  mac: { readonly app: string; readonly cli: string },
  linux: ReadonlyArray<string>,
): Family => ({
  id,
  label,
  style: "vscode",
  locations: (platform, env) => {
    if (platform === "win32") {
      const local = env["LOCALAPPDATA"];
      return [
        ...(local ? [join(local, "Programs", windows.folder, windows.exe)] : []),
        ...programFiles(env).map((root) => join(root, windows.folder, windows.exe)),
      ];
    }
    if (platform === "darwin") {
      return [
        join("/Applications", `${mac.app}.app`, "Contents", "Resources", "app", "bin", mac.cli),
        join(homedir(), "Applications", `${mac.app}.app`, "Contents", "Resources", "app", "bin", mac.cli),
      ];
    }
    return linux;
  },
});

/** JetBrains' IDEs: the product's name for a folder or bundle, and the launcher it ships. */
const JETBRAINS = [
  { id: "idea", label: "IntelliJ IDEA", folder: "IntelliJ IDEA", launcher: "idea" },
  { id: "webstorm", label: "WebStorm", folder: "WebStorm", launcher: "webstorm" },
  { id: "pycharm", label: "PyCharm", folder: "PyCharm", launcher: "pycharm" },
  { id: "goland", label: "GoLand", folder: "GoLand", launcher: "goland" },
  { id: "rustrover", label: "RustRover", folder: "RustRover", launcher: "rustrover" },
  { id: "rider", label: "Rider", folder: "Rider", launcher: "rider" },
  { id: "phpstorm", label: "PhpStorm", folder: "PhpStorm", launcher: "phpstorm" },
  { id: "rubymine", label: "RubyMine", folder: "RubyMine", launcher: "rubymine" },
  { id: "clion", label: "CLion", folder: "CLion", launcher: "clion" },
] as const;

const FAMILIES: ReadonlyArray<Family> = [
  vscodeFamily(
    "vscode",
    "VS Code",
    { folder: "Microsoft VS Code", exe: "Code.exe" },
    { app: "Visual Studio Code", cli: "code" },
    ["/usr/bin/code", "/snap/bin/code", "/usr/local/bin/code"],
  ),
  vscodeFamily(
    "cursor",
    "Cursor",
    { folder: "cursor", exe: "Cursor.exe" },
    { app: "Cursor", cli: "cursor" },
    ["/usr/bin/cursor", "/usr/local/bin/cursor", "/opt/Cursor/cursor"],
  ),
  {
    id: "zed",
    label: "Zed",
    style: "zed",
    locations: (platform, env) => {
      if (platform === "win32") {
        const local = env["LOCALAPPDATA"];
        return local
          ? [join(local, "Programs", "Zed", "Zed.exe"), join(local, "Programs", "Zed", "bin", "zed.exe")]
          : [];
      }
      if (platform === "darwin") return ["/Applications/Zed.app/Contents/MacOS/cli"];
      return [
        join(homedir(), ".local", "bin", "zed"),
        "/usr/bin/zed",
        "/usr/bin/zeditor",
        "/usr/local/bin/zed",
      ];
    },
  },
  ...JETBRAINS.map(({ id, label, folder, launcher }): Family => ({
    id,
    label,
    style: "jetbrains",
    locations: (platform, env) => {
      if (platform === "win32") return jetbrainsWindows(env, folder, launcher);
      if (platform === "darwin") return jetbrainsMac(folder, launcher);
      return jetbrainsLinux(folder, launcher);
    },
  })),
  {
    id: "visualStudio",
    label: "Visual Studio",
    style: "visualStudio",
    locations: () => [],
  },
];

/** The subfolders of `parent` whose name starts with `prefix`, newest name first; none when it isn't there. */
const children = (parent: string, prefix: string): ReadonlyArray<string> => {
  try {
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .toSorted()
      .toReversed()
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
};

/**
 * A JetBrains IDE on Windows: the installer's own folder under Program Files, the Toolbox app's
 * install under Local\Programs, and the builds Toolbox keeps under its own folder.
 */
const jetbrainsWindows = (env: Env, folder: string, launcher: string): ReadonlyArray<string> => {
  const exe = join("bin", `${launcher}64.exe`);
  const local = env["LOCALAPPDATA"];
  return [
    ...programFiles(env).flatMap((root) => children(join(root, "JetBrains"), folder)),
    ...(local
      ? [
          ...children(join(local, "Programs"), folder),
          ...children(
            join(local, "JetBrains", "Toolbox", "apps", folder.replaceAll(" ", "-")),
            "ch-",
          ).flatMap((channel) => children(channel, "")),
        ]
      : []),
  ].map((root) => join(root, exe));
};

const jetbrainsMac = (folder: string, launcher: string): ReadonlyArray<string> =>
  [
    ...children("/Applications", folder),
    ...children(join(homedir(), "Applications"), folder),
    ...children(join(homedir(), "Applications", "JetBrains Toolbox"), folder),
  ]
    .filter((app) => app.endsWith(".app"))
    .map((app) => join(app, "Contents", "MacOS", launcher));

const jetbrainsLinux = (folder: string, launcher: string): ReadonlyArray<string> => [
  join(homedir(), ".local", "share", "JetBrains", "Toolbox", "scripts", launcher),
  join("/snap/bin", launcher),
  ...children("/opt", folder.replaceAll(" ", "-").toLowerCase()).map((root) =>
    join(root, "bin", `${launcher}.sh`),
  ),
  join("/usr/local/bin", launcher),
];

/**
 * Visual Studio's newest install that has the editor, which its installer's `vswhere` names (the Build
 * Tools have none, and name a script); nothing off Windows.
 */
const visualStudioProgram = (env: Env): Promise<string | undefined> => {
  const root = env["ProgramFiles(x86)"] ?? env["ProgramFiles"];
  if (root === undefined) return Promise.resolve(undefined);
  const vswhere = join(root, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!existsSync(vswhere)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.CoreEditor",
        "-property",
        "productPath",
      ],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        const found = error ? "" : (stdout.trim().split(/\r?\n/)[0] ?? "");
        resolve(/devenv.exe$/i.test(found) && existsSync(found) ? found : undefined);
      },
    );
  });
};

/** The first of `locations` that exists, which is a file for every editor but a JetBrains `.app`'s launcher. */
const firstExisting = (locations: ReadonlyArray<string>): string | undefined =>
  locations.find((location) => existsSync(location));

/**
 * Where an editor on the `PATH` lives, for ones a package manager put there: the program's file name
 * looked up in each folder, with `.exe` too on Windows.
 */
const onPath = (names: ReadonlyArray<string>, platform: Platform, env: Env): string | undefined => {
  const separator = platform === "win32" ? ";" : ":";
  const folders = (env["PATH"] ?? env["Path"] ?? "").split(separator).filter((each) => each !== "");
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, platform === "win32" ? `${name}.exe` : name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
};

/** On Windows, a launcher script on the `PATH` (`code.cmd`) sits in `bin`, beside the executable above it. */
const windowsLauncherSibling = (cmd: string, exe: string): string | undefined => {
  const candidate = join(dirname(cmd), "..", exe);
  return existsSync(candidate) ? normalize(candidate) : undefined;
};

/** The names an editor answers to on the `PATH`. */
const PATH_NAMES: Readonly<Record<string, ReadonlyArray<string>>> = {
  vscode: ["code"],
  cursor: ["cursor"],
  zed: ["zed", "zeditor"],
  ...Object.fromEntries(JETBRAINS.map(({ id, launcher }) => [id, [launcher]])),
};

/** Windows' VS Code and Cursor put a `.cmd` on the `PATH`; their executable is what to start. */
const WINDOWS_EXE: Readonly<Record<string, string>> = { vscode: "Code.exe", cursor: "Cursor.exe" };

/** Every editor of the families this machine has, in the order the user would be offered them. */
export const findEditors = async (
  platform: Platform = process.platform as Platform,
  env: Env = process.env,
): Promise<ReadonlyArray<FoundEditor>> => {
  const found: FoundEditor[] = [];
  for (const family of FAMILIES) {
    if (family.id === "visualStudio") {
      if (platform !== "win32") continue;
      const program = await visualStudioProgram(env);
      if (program !== undefined) found.push({ id: family.id, label: family.label, program });
      continue;
    }
    let program = firstExisting(family.locations(platform, env));
    if (program === undefined) {
      const named = PATH_NAMES[family.id];
      const onTheWay = named === undefined ? undefined : onPath(named, platform, env);
      if (onTheWay !== undefined) program = onTheWay;
      else if (platform === "win32" && WINDOWS_EXE[family.id] !== undefined) {
        // `code.cmd`, not `code.exe`, is what the PATH holds; its executable is one folder up.
        const folders = (env["PATH"] ?? env["Path"] ?? "").split(";");
        const cmd = folders
          .map((folder) => join(folder, `${PATH_NAMES[family.id]?.[0]}.cmd`))
          .find((candidate) => existsSync(candidate));
        program = cmd === undefined ? undefined : windowsLauncherSibling(cmd, WINDOWS_EXE[family.id]!);
      }
    }
    if (program !== undefined) found.push({ id: family.id, label: family.label, program });
  }
  return found;
};

/** What the UI is told: the editors, without where they live. */
export const editorList = (found: ReadonlyArray<FoundEditor>): ReadonlyArray<Editor> =>
  found.map(({ id, label }) => ({ id, label }));

const MAX_LINE = 10_000_000;

/** A line from the UI, which is whole and from 1, or none. */
export const validLine = (line: unknown): number | undefined =>
  typeof line === "number" && Number.isInteger(line) && line >= 1 && line <= MAX_LINE ? line : undefined;

const styleOf = (id: string): Style | undefined => FAMILIES.find((family) => family.id === id)?.style;

const DETECTION_TTL_MS = 60_000;
let detected: { readonly at: number; readonly editors: Promise<ReadonlyArray<FoundEditor>> } | undefined;

/** The editors on this machine, looked for again once a minute has passed since the last look. */
const installed = (fresh: boolean): Promise<ReadonlyArray<FoundEditor>> => {
  if (detected === undefined || fresh || Date.now() - detected.at > DETECTION_TTL_MS) {
    detected = { at: Date.now(), editors: findEditors() };
  }
  return detected.editors;
};

/** The editors installed here, for the UI's choice. */
export const listEditors = async (fresh = false): Promise<ReadonlyArray<Editor>> =>
  editorList(await installed(fresh));

/**
 * Opens `file` at `line` in the editor `id`, started by itself and left running. Only absolute paths,
 * and only an editor that was found: nothing the UI sends is a program to run. Resolves whether it
 * started.
 */
export const openInEditor = async (
  id: unknown,
  file: unknown,
  line: unknown,
  folder: unknown,
): Promise<boolean> => {
  if (typeof id !== "string" || typeof file !== "string" || !isAbsolute(file)) return false;
  const editor = (await installed(false)).find((each) => each.id === id);
  const style = styleOf(id);
  if (editor === undefined || style === undefined) return false;
  const target: Target = {
    file: normalize(file),
    line: validLine(line),
    folder: typeof folder === "string" && isAbsolute(folder) ? normalize(folder) : undefined,
  };
  return new Promise((resolve) => {
    try {
      const child = spawn(editor.program, [...editorArgs(style, target)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
};
