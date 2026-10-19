import { shell } from "electron";
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

const runnable = (path: string): boolean => {
  const extension = extname(path).toLowerCase();
  if (extension === "") return false;
  const listed = (process.env.PATHEXT ?? ".com;.exe;.bat;.cmd;.vbs;.vbe;.js;.jse;.wsf;.wsh;.msc")
    .toLowerCase()
    .split(";");
  return listed.includes(extension) || RUNNABLE.includes(extension);
};

/**
 * Opens a file the explorer lists in the app the system gives its kind; only absolute paths. A
 * program or script isn't run: its folder opens with it selected. (Windows' own Open with refuses
 * these kinds without a word.) A kind with no app gets Windows' chooser.
 */
export const openPath = async (target: unknown): Promise<void> => {
  if (typeof target !== "string" || !isAbsolute(target)) return;
  const path = normalize(target);
  if (runnable(path)) shell.showItemInFolder(path);
  else await shell.openPath(path);
};
