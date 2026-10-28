import type { Mention } from "@cerium/protocol";

import { relativePath, resolvePath } from "./paths.ts";

/** Marks a rendered link with its address, for the message menu's link items. */
export const LINK_ATTRIBUTE = "data-link";

export const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);

/** Only `https` links open, as the shell opens nothing else. */
export const isOpenableLink = (href: string): boolean => {
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
};

/** What a file chip's menu can work with. */
export interface FileTargets {
  /** The file on disk, when it can be told. */
  readonly location?: string;
  /** Relative to the thread's folder, when the file is inside it. */
  readonly relative?: string;
  /** The `@` tag for it, when it is inside the thread's folder. */
  readonly mention?: Mention;
}

export const fileTargets = (path: string, folder: boolean, workspace: string | undefined): FileTargets => {
  const location = resolvePath(path, workspace);
  const relative = location === undefined ? undefined : relativePath(location, workspace);
  return {
    ...(location === undefined ? {} : { location }),
    ...(relative === undefined
      ? {}
      : { relative, mention: { _tag: "FileMention", path: relative, folder } satisfies Mention }),
  };
};
