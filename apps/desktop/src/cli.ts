import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, normalize } from "node:path";

import { linuxInstall } from "./linuxInstall.ts";

// The `cerium` command: a small launcher the user can put on their PATH, which starts Cerium with the
// arguments it was given (launch.ts). It lives in a folder of Cerium's own, never one the system
// owns: on Windows `%LOCALAPPDATA%\Cerium\bin`, added to the user's PATH, and elsewhere
// `~/.local/bin`, which most distributions and shells already have on it.

/** What Settings shows of the command. */
export interface CliState {
  /** This build can install it: only the installed app, whose program is where the shim points. */
  readonly available: boolean;
  /** The shim is there and starts this install. */
  readonly installed: boolean;
  /** The folder the shim lives in. */
  readonly folder: string;
  /** A terminal opened now finds the shim: its folder is on the PATH. */
  readonly onPath: boolean;
}

type Platform = "win32" | "darwin" | "linux";

export const NAME = "cerium";

/** Quotes `text` for `sh`: in single quotes, which take everything literally but a single quote. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The launcher for `program`. On Windows a batch file that starts it detached, as a GUI program, so
 * the terminal is free again; elsewhere a script that does the same and survives the terminal closing.
 */
export const shimFor = (platform: Platform, program: string): string =>
  platform === "win32"
    ? `@echo off\r\nstart "" "${program}" %*\r\n`
    : `#!/bin/sh\nnohup ${shellQuote(program)} "$@" >/dev/null 2>&1 &\n`;

/** Where the shim goes, and the folder that holds it. */
export const shimLocation = (
  platform: Platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): { readonly folder: string; readonly file: string } => {
  const folder =
    platform === "win32"
      ? join(env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"), "Cerium", "bin")
      : join(home, ".local", "bin");
  return { folder, file: join(folder, platform === "win32" ? `${NAME}.cmd` : NAME) };
};

/** Whether `folder` is one of the folders in `path`, which is `PATH` or the user's registry value. */
export const pathHas = (path: string, folder: string, separator: string = delimiter): boolean => {
  const clean = (each: string) => normalize(each.replace(/^"|"$/g, "")).replace(/[\\/]+$/, "");
  const wanted = clean(folder).toLowerCase();
  return path
    .split(separator)
    .filter((each) => each.trim() !== "")
    .some((each) => clean(each).toLowerCase() === wanted);
};

/** The program the shim starts: the AppImage or installed package on Linux, the executable elsewhere. */
const programOf = (platform: Platform): string | undefined =>
  platform === "linux" ? linuxInstall()?.program : process.execPath;

const run = (file: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: 15_000, ...(env ? { env } : {}) },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/**
 * The user's own PATH on Windows, as stored: what a new terminal starts with, before the machine's
 * entries are added. Empty when they have none.
 */
const userPath = async (): Promise<string> => {
  const out = await run("reg", ["query", "HKCU\\Environment", "/v", "Path"]).catch(() => "");
  return /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out)?.[1]?.trim() ?? "";
};

/**
 * Adds or removes `folder` in the user's PATH on Windows, in place: the entries stay as the user wrote
 * them (`%USERPROFILE%` unexpanded) and the value keeps being expandable. Then tells the running
 * programs the environment changed, so a terminal opened next finds it.
 */
const SET_USER_PATH = `
$folder = $env:CERIUM_BIN
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($raw -split ';' | Where-Object { $_ -ne '' })
$kept = @($parts | Where-Object { $_.Trim('"').TrimEnd('\\') -ne $folder.TrimEnd('\\') })
if ($env:CERIUM_ADD -eq '1') { $kept += $folder }
if (($kept -join ';') -ne ($parts -join ';')) {
  $key.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
  Add-Type -Namespace Cerium -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
  $result = [UIntPtr]::Zero
  [void][Cerium.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}
$key.Close()
`;

const setWindowsPath = (folder: string, add: boolean): Promise<string> =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SET_USER_PATH], {
    ...process.env,
    CERIUM_BIN: folder,
    CERIUM_ADD: add ? "1" : "0",
  });

/** Whether the shim at `file` is there and starts `program`. */
const shimInstalled = async (platform: Platform, file: string, program: string): Promise<boolean> =>
  (await readFile(file, "utf8").catch(() => undefined)) === shimFor(platform, program);

/** Whether a terminal opened now finds the folder: on Windows the user's stored PATH, elsewhere the login shell's. */
const onPathNow = async (platform: Platform, folder: string): Promise<boolean> => {
  if (platform === "win32")
    return pathHas(await userPath(), folder, ";") || pathHas(process.env["PATH"] ?? "", folder);
  return pathHas(process.env["PATH"] ?? "", folder);
};

/** The command's state on this computer. `shellPath` is the PATH the user's login shell has, where it can say. */
export const cliState = async (
  packaged: boolean,
  shellPath?: () => Promise<string | undefined>,
  platform: Platform = process.platform as Platform,
): Promise<CliState> => {
  const { folder, file } = shimLocation(platform);
  const program = packaged ? programOf(platform) : undefined;
  if (program === undefined) return { available: false, installed: false, folder, onPath: false };
  const installed = await shimInstalled(platform, file, program);
  const loginPath = platform === "win32" ? undefined : await shellPath?.();
  const onPath =
    loginPath === undefined
      ? await onPathNow(platform, folder)
      : pathHas(loginPath, folder) || (await onPathNow(platform, folder));
  return { available: true, installed, folder, onPath };
};

/** Writes the shim, and on Windows puts its folder on the user's PATH. */
export const installCli = async (platform: Platform = process.platform as Platform): Promise<void> => {
  const program = programOf(platform);
  if (program === undefined) return;
  const { folder, file } = shimLocation(platform);
  await mkdir(folder, { recursive: true });
  await writeFile(file, shimFor(platform, program));
  if (platform !== "win32") await chmod(file, 0o755);
  else await setWindowsPath(folder, true);
};

/** Removes the shim and, on Windows, its folder from the user's PATH. */
export const removeCli = async (platform: Platform = process.platform as Platform): Promise<void> => {
  const { folder, file } = shimLocation(platform);
  await rm(file, { force: true });
  if (platform === "win32") {
    await setWindowsPath(folder, false);
    await rmdir(folder).catch(() => undefined);
  }
};

/**
 * Points an installed shim at this install again, which an update that moved the program, or a
 * reinstall, leaves stale. Nothing happens when the user never installed the command.
 */
export const refreshCli = async (platform: Platform = process.platform as Platform): Promise<void> => {
  const program = programOf(platform);
  if (program === undefined) return;
  const { file } = shimLocation(platform);
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current === undefined || current === shimFor(platform, program)) return;
  await writeFile(file, shimFor(platform, program));
  if (platform !== "win32") await chmod(file, 0o755);
};
