import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Starting at login on Linux, where Electron's login items don't reach: an XDG autostart entry, which
// GNOME, KDE and the other desktops (and Hyprland or Sway through a helper) start at sign-in. Only an
// AppImage can have one: its path stays put, while the folder Electron runs from is mounted anew at
// each launch.

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

/** The AppImage Cerium runs from; its runtime names it in `APPIMAGE`. */
export const appImagePath = (): string | undefined => process.env["APPIMAGE"] || undefined;

/** Whether the entry is there and starts this AppImage. */
export const autostartEnabled = async (): Promise<boolean> => {
  const program = appImagePath();
  if (program === undefined) return false;
  const entry = await readFile(entryFile(), "utf8").catch(() => undefined);
  return entry?.includes(`Exec=${quoteExecArg(program)} `) === true;
};

export const setAutostart = async (enabled: boolean, args: ReadonlyArray<string>): Promise<void> => {
  const program = appImagePath();
  const file = entryFile();
  if (!enabled || program === undefined) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, desktopEntry(program, args));
};
