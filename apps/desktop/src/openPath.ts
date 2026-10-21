import { shell } from "electron";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, normalize } from "node:path";

/**
 * Kinds Windows runs, installs or merges rather than shows, besides those `PATHEXT` lists. Opening one
 * of these from the explorer would run whatever an agent wrote there.
 */
const RUNNABLE = [
  ".appinstaller",
  ".application",
  ".appref-ms",
  ".appx",
  ".appxbundle",
  ".cpl",
  ".diagcab",
  ".gadget",
  ".hta",
  ".inf",
  ".jar",
  ".library-ms",
  ".lnk",
  ".msc",
  ".msi",
  ".msix",
  ".msixbundle",
  ".msp",
  ".pif",
  ".ps1",
  ".psm1",
  ".reg",
  ".scf",
  ".scr",
  ".search-ms",
  ".settingcontent-ms",
  ".url",
  ".ws",
];

/**
 * Kinds a Linux desktop runs or installs rather than shows: launchers, self-contained apps, scripts
 * and packages, and Windows programs where Wine is set up. Any file marked executable counts too.
 */
const LINUX_RUNNABLE = [
  ".appimage",
  ".bash",
  ".bin",
  ".deb",
  ".desktop",
  ".exe",
  ".flatpak",
  ".flatpakref",
  ".flatpakrepo",
  ".jar",
  ".msi",
  ".run",
  ".rpm",
  ".sh",
  ".snap",
  ".zsh",
];

const runnableOnWindows = (path: string): boolean => {
  const extension = extname(path).toLowerCase();
  if (extension === "") return false;
  const listed = (process.env.PATHEXT ?? ".com;.exe;.bat;.cmd;.vbs;.vbe;.js;.jse;.wsf;.wsh;.msc")
    .toLowerCase()
    .split(";");
  return listed.includes(extension) || RUNNABLE.includes(extension);
};

const runnableOnLinux = async (path: string): Promise<boolean> => {
  if (LINUX_RUNNABLE.includes(extname(path).toLowerCase())) return true;
  const file = await stat(path).catch(() => undefined);
  return file !== undefined && file.isFile() && (file.mode & 0o111) !== 0;
};

/**
 * Opens a file the explorer lists in the app the system gives its kind; only absolute paths. A
 * program or script isn't run: its folder opens with it selected. (Windows' own Open with refuses
 * these kinds without a word.) A kind with no app gets the system's chooser.
 */
export const openPath = async (target: unknown): Promise<void> => {
  if (typeof target !== "string" || !isAbsolute(target)) return;
  const path = normalize(target);
  const runnable = process.platform === "win32" ? runnableOnWindows(path) : await runnableOnLinux(path);
  if (runnable) shell.showItemInFolder(path);
  else await shell.openPath(path);
};
