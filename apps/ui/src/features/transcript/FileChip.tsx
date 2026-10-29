import { AtSign, Copy, FolderOpen, SquareArrowOutUpRight } from "lucide-react";
import { createContext, useContext } from "react";

import { revealPlace, shellBridge } from "../../backend/shell.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { baseName } from "../../components/fileIcons/index.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useMessageBox } from "../composer/messageBox.ts";
import { useEditor } from "../editor/useEditor.ts";
import { copyText, fileTargets } from "./menus.ts";

/** The thread's folder, which the relative paths in its transcript are relative to. */
export const WorkspaceFolder = createContext<string | undefined>(undefined);

/** Shared look of every chip: files, folders and skills, in the transcript and the message box. */
export const chipClass =
  "inline-flex max-w-full items-center gap-[0.3em] rounded-[0.3125rem] border border-line-subtle bg-surface-hover px-[0.35em] align-[-0.12em] text-[0.9em] leading-[1.45] font-medium text-fg-primary";

/** A skill the user tagged with `$`. */
export function SkillChip({ name }: { name: string }) {
  return (
    <Tooltip label={`Skill: ${name}`} side="top">
      <span className={chipClass}>
        <FileIcon skill className="size-[1.1em]" />
        <span className="min-w-0 truncate">{name}</span>
      </span>
    </Tooltip>
  );
}

/**
 * A file or folder named in the conversation: its type's icon and its name, the full path on hover.
 * Clicking shows it in the file manager when the shell can; right-click for its menu.
 */
export function FileChip({
  path,
  folder,
  line,
}: {
  path: string;
  folder: boolean;
  line?: number | undefined;
}) {
  const workspace = useContext(WorkspaceFolder);
  const { location, relative, mention } = fileTargets(path, folder, workspace);
  const reveal = shellBridge()?.revealPath;
  // A file opens in the user's editor, at its line; a folder, or a machine with no editor, shows it.
  const editor = useEditor();
  const openInEditor =
    folder || location === undefined || editor.open === undefined
      ? undefined
      : () => editor.open?.(location, line, workspace);
  const activate = openInEditor ?? (reveal && location ? () => void reveal(location) : undefined);
  const messageBox = useMessageBox();
  const suffix = line === undefined ? "" : `:${line}`;
  const content = (
    <>
      <FileIcon path={path} folder={folder} className="size-[1.1em]" />
      <span className="min-w-0 truncate">
        {baseName(path)}
        {suffix}
      </span>
    </>
  );
  const label = (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono text-caption">
        {path}
        {suffix}
      </span>
      {activate ? (
        <span className="text-caption text-fg-tertiary">
          {openInEditor ? `Click to open in ${editor.editor?.label}` : `Click to show in ${revealPlace()}`}
        </span>
      ) : null}
    </span>
  );
  const chip = (
    <Tooltip label={label} side="top">
      {activate ? (
        <button
          type="button"
          onClick={activate}
          className={`${chipClass} cursor-pointer transition-colors hover:bg-surface-active data-popup-open:bg-surface-active`}
        >
          {content}
        </button>
      ) : (
        <span className={`${chipClass} data-popup-open:bg-surface-active`}>{content}</span>
      )}
    </Tooltip>
  );
  // Everything the menu offers needs to know where the file is.
  if (location === undefined) return chip;
  const act = reveal || openInEditor || (mention && messageBox);
  return (
    <ContextMenuArea
      menu={
        <>
          {openInEditor ? (
            <MenuItem icon={SquareArrowOutUpRight} onClick={openInEditor}>
              Open in {editor.editor?.label}
            </MenuItem>
          ) : null}
          {reveal ? (
            <MenuItem icon={FolderOpen} onClick={() => void reveal(location)}>
              Show in {revealPlace()}
            </MenuItem>
          ) : null}
          {mention && messageBox ? (
            <MenuItem icon={AtSign} onClick={() => messageBox.mention(mention)}>
              Mention in message
            </MenuItem>
          ) : null}
          {act ? <MenuSeparator /> : null}
          <MenuItem icon={Copy} onClick={() => copyText(location)}>
            Copy path
          </MenuItem>
          {relative ? (
            <MenuItem icon={Copy} onClick={() => copyText(relative)}>
              Copy relative path
            </MenuItem>
          ) : null}
        </>
      }
    >
      {chip}
    </ContextMenuArea>
  );
}
