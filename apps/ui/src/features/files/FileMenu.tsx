import { AtSign, Code, Copy, FileText, FolderOpen, SquareArrowOutUpRight } from "lucide-react";

import { revealPlace, shellBridge } from "../../backend/shell.ts";
import { MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { useEditor } from "../editor/useEditor.ts";
import type { MessageBox } from "../composer/messageBox.ts";
import { copyText, fileTargets } from "../transcript/menus.ts";

/**
 * What the explorer offers for a file or folder, as a file chip in the transcript does: open a file in
 * its own app, show it in the file manager, mention it in the message, copy its path or the one relative
 * to the thread's folder. For a menu opened over a row.
 */
export function FileMenuItems({
  path,
  folder,
  root,
  gone = false,
  messageBox,
  onOpen,
}: {
  /** Relative to `root`. */
  path: string;
  folder: boolean;
  /** The thread's folder. */
  root: string;
  /** Deleted: there is nothing on disk to show. */
  gone?: boolean;
  messageBox: MessageBox | undefined;
  /** Opens the file in Cerium's viewer, in a tab of its own; absent where it can't, or already shows it. */
  onOpen?: (() => void) | undefined;
}) {
  const { location, relative, mention } = fileTargets(path, folder, root);
  const reveal = gone ? undefined : shellBridge()?.revealPath;
  const openOutside = gone || folder ? undefined : shellBridge()?.openPath;
  const editor = useEditor();
  const openInEditor = gone || folder ? undefined : editor.open;
  if (location === undefined) return null;
  const canMention = mention !== undefined && messageBox !== undefined;
  return (
    <>
      {onOpen && !folder ? (
        <MenuItem icon={FileText} onClick={onOpen}>
          Open
        </MenuItem>
      ) : null}
      {openInEditor ? (
        <MenuItem icon={Code} onClick={() => openInEditor(location, undefined, root)}>
          Open in {editor.editor?.label}
        </MenuItem>
      ) : null}
      {openOutside ? (
        <MenuItem icon={SquareArrowOutUpRight} onClick={() => void openOutside(location)}>
          {onOpen || openInEditor ? "Open in its app" : "Open"}
        </MenuItem>
      ) : null}
      {reveal ? (
        <MenuItem icon={FolderOpen} onClick={() => void reveal(location)}>
          Show in {revealPlace()}
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
