import {
  DEFAULT_FILE_ICON,
  DEFAULT_FOLDER_ICON,
  extensionIcons,
  fileNameIcons,
  fileNamePrefixIcons,
  folderIcons,
  SKILL_ICON,
} from "./names.ts";
import { svgs } from "./svgs.ts";

/** The last segment of a path, ignoring a trailing separator. */
export const baseName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? path;

/** The extension `name` is known by, longest first (`d.ts` before `ts`); undefined when it has none. */
export const knownExtension = (name: string): string | undefined => {
  const parts = name.toLowerCase().split(".");
  for (let index = 1; index < parts.length; index++) {
    const extension = parts.slice(index).join(".");
    if (extension in extensionIcons) return extension;
  }
  return undefined;
};

/** Whether `name` is a file Cerium has an icon for by its whole name (`Makefile`, `.gitignore`). */
export const knownFileName = (name: string): boolean => name.toLowerCase() in fileNameIcons;

const iconName = (path: string, folder: boolean): string => {
  const name = baseName(path).toLowerCase();
  if (folder) return folderIcons[name] ?? DEFAULT_FOLDER_ICON;
  const named = fileNameIcons[name] ?? fileNamePrefixIcons.find(([prefix]) => name.startsWith(prefix))?.[1];
  if (named) return named;
  const extension = knownExtension(name);
  return extension ? extensionIcons[extension]! : DEFAULT_FILE_ICON;
};

/** The SVG markup of the icon for a file or folder. */
export const fileIconSvg = (path: string, folder: boolean): string =>
  svgs[iconName(path, folder)] ?? svgs[DEFAULT_FILE_ICON]!;

export const skillIconSvg = (): string => svgs[SKILL_ICON]!;
