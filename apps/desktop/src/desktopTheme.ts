import { BrowserWindow, nativeImage, systemPreferences, type NativeImage } from "electron";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { dominantColor, oklchFromHex, type DesktopColors, type Oklch } from "./desktopColors.ts";

// The Desktop theme's colours, read from the system: its accent colour wherever Electron gives one,
// and on Windows the wallpaper too. Read when a page first asks, then again whenever the accent or
// the wallpaper changes, and sent to every window then.

const SPI_GETDESKWALLPAPER = 0x0073;
const MAX_PATH = 260;
const COLOR_DESKTOP = 1;

const loadUser32 = async () => {
  const { default: koffi } = await import("koffi");
  const user32 = koffi.load("user32.dll");
  return {
    systemParametersInfo: user32.func(
      "bool __stdcall SystemParametersInfoW(uint32_t uiAction, uint32_t uiParam, _Out_ void *pvParam, uint32_t fWinIni)",
    ),
    getSysColor: user32.func("uint32_t __stdcall GetSysColor(int nIndex)"),
  };
};

let user32: ReturnType<typeof loadUser32> | undefined;

/** The copy of the wallpaper Windows keeps as it draws it, a JPEG whatever the original was. */
const transcodedWallpaper = () =>
  join(process.env["APPDATA"] ?? "", "Microsoft", "Windows", "Themes", "TranscodedWallpaper");

const accent = (): Oklch | undefined => {
  try {
    const hex = systemPreferences.getAccentColor();
    return hex ? oklchFromHex(hex) : undefined;
  } catch {
    return undefined;
  }
};

const decode = async (path: string): Promise<NativeImage | undefined> => {
  try {
    const image = nativeImage.createFromBuffer(await readFile(path));
    return image.isEmpty() ? undefined : image;
  } catch {
    return undefined;
  }
};

/** The Windows wallpaper's colour and a thumbnail of it, or the desktop's colour when it has no picture. */
const windowsWallpaper = async (): Promise<Pick<DesktopColors, "wallpaper" | "thumbnail">> => {
  const { systemParametersInfo, getSysColor } = await (user32 ??= loadUser32());
  const buffer = Buffer.alloc(MAX_PATH * 2);
  const path = systemParametersInfo(SPI_GETDESKWALLPAPER, MAX_PATH, buffer, 0)
    ? buffer.toString("utf16le").split("\0")[0]!
    : "";
  if (path === "") {
    const color = Number(getSysColor(COLOR_DESKTOP));
    const hex = [color & 0xff, (color >> 8) & 0xff, (color >> 16) & 0xff]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("");
    return { wallpaper: oklchFromHex(hex) };
  }
  const image = (await decode(transcodedWallpaper())) ?? (await decode(path));
  if (image === undefined) return {};
  return {
    wallpaper: dominantColor(image.resize({ width: 64, quality: "good" }).toBitmap()),
    thumbnail: `data:image/jpeg;base64,${image.resize({ width: 400, quality: "good" }).toJPEG(80).toString("base64")}`,
  };
};

const read = async (): Promise<DesktopColors> => {
  const wallpaper = process.platform === "win32" ? await windowsWallpaper().catch(() => ({})) : {};
  return { accent: accent(), ...wallpaper };
};

/** The desktop's colours for the Desktop theme, kept current once a page has asked for them. */
export const desktopTheme = () => {
  let colors: Promise<DesktopColors> | undefined;
  let refreshing: ReturnType<typeof setTimeout> | undefined;

  /** Reads the colours again, a moment after the system says they changed, and sends them on. */
  const refresh = () => {
    clearTimeout(refreshing);
    refreshing = setTimeout(() => {
      const previous = colors;
      colors = read();
      void Promise.all([previous, colors]).then(([before, after]) => {
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("cerium:desktop-colors", after);
        }
      });
    }, 400);
  };

  const follow = () => {
    if (process.platform === "darwin") {
      systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", refresh);
      return;
    }
    systemPreferences.on("accent-color-changed", refresh);
    if (process.platform !== "win32") return;
    // A solid desktop colour changing; a picture changing rewrites the transcoded copy.
    systemPreferences.on("color-changed", refresh);
    try {
      watch(dirname(transcodedWallpaper()), (_event, name) => {
        if (name === "TranscodedWallpaper") refresh();
      }).on("error", () => undefined);
    } catch {
      // No Themes folder: the wallpaper was never set, and the accent alone still follows.
    }
  };

  return {
    colors: (): Promise<DesktopColors> => {
      if (colors === undefined) {
        colors = read();
        follow();
      }
      return colors;
    },
  };
};
