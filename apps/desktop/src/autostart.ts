import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { linuxInstall } from "./linuxInstall.ts";

// Starting at login on Linux, where Electron's login items don't reach: an XDG autostart entry, which
// GNOME, KDE and the other desktops (and Hyprland or Sway through a helper) start at sign-in. It starts
// the AppImage's own file, since the folder Electron runs from is mounted anew at each launch, or the
// program a .deb or .rpm package installed, which stays put (linuxInstall.ts).

/** Quotes `arg` for a desktop entry's `Exec` key, as the Desktop Entry Specification asks. */
export const quoteExecArg = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["`$\\])/g, "\\$1")}"`;

/** The autostart entry that starts `program` with `args`. */
export const desktopEntry = (program: string, args: ReadonlyArray<string>): string =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cerium",
    "Comment=Keeps this computer reachable from your other devices",
    `Exec=${[program, ...args].map(quoteExecArg).join(" ")}`,
    "Icon=cerium",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");

const entryFile = () =>
  join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "autostart", "cerium.desktop");

/** The program an autostart entry starts: the AppImage, or the packaged install's executable. */
export const autostartProgram = (): string | undefined => linuxInstall()?.program;

/** Whether the entry is there and starts this install. */
export const autostartEnabled = async (): Promise<boolean> => {
  const program = autostartProgram();
  if (program === undefined) return false;
  const entry = await readFile(entryFile(), "utf8").catch(() => undefined);
  return entry?.includes(`Exec=${quoteExecArg(program)} `) === true;
};

export const setAutostart = async (enabled: boolean, args: ReadonlyArray<string>): Promise<void> => {
  const program = autostartProgram();
  const file = entryFile();
  if (!enabled || program === undefined) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, desktopEntry(program, args));
};
