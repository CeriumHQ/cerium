import { AtSign, Copy, FolderOpen, SquareArrowOutUpRight } from "lucide-react";

import { shellBridge } from "../../backend/shell.ts";
import { MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import type { MessageBox } from "../composer/messageBox.ts";
import { copyText, fileTargets } from "../transcript/menus.ts";

/**
 * What the explorer offers for a file or folder, as a file chip in the transcript does: open a file in
 * its own app, show it in File Explorer, mention it in the message, copy its path or the one relative
 * to the thread's folder. For a menu opened over a row.
 */
export function FileMenuItems({
  path,
  folder,
  root,
  gone = false,
  messageBox,
}: {
  /** Relative to `root`. */
  path: string;
  folder: boolean;
  /** The thread's folder. */
  root: string;
  /** Deleted: there is nothing on disk to show. */
  gone?: boolean;
  messageBox: MessageBox | undefined;
}) {
  const { location, relative, mention } = fileTargets(path, folder, root);
  const reveal = gone ? undefined : shellBridge()?.revealPath;
  const open = gone || folder ? undefined : shellBridge()?.openPath;
  if (location === undefined) return null;
  const canMention = mention !== undefined && messageBox !== undefined;
  return (
    <>
      {open ? (
        <MenuItem icon={SquareArrowOutUpRight} onClick={() => void open(location)}>
          Open
        </MenuItem>
      ) : null}
      {reveal ? (
        <MenuItem icon={FolderOpen} onClick={() => void reveal(location)}>
          Show in File Explorer
        </MenuItem>
      ) : null}
      {canMention ? (
        <MenuItem icon={AtSign} onClick={() => messageBox.mention(mention)}>
          Mention in message
        </MenuItem>
      ) : null}
      {reveal || canMention ? <MenuSeparator /> : null}
      <MenuItem icon={Copy} onClick={() => copyText(location)}>
        Copy path
      </MenuItem>
      {relative ? (
        <MenuItem icon={Copy} onClick={() => copyText(relative)}>
          Copy relative path
        </MenuItem>
      ) : null}
    </>
  );
}
