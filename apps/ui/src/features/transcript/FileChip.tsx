import { AtSign, Copy, FolderOpen } from "lucide-react";
import { createContext, useContext } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { baseName } from "../../components/fileIcons/index.ts";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useMessageBox } from "../composer/messageBox.ts";
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
 * Clicking shows it in File Explorer when the shell can; right-click for its menu.
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
  const { location, relative, mention } = fileTargets(path, folder, useContext(WorkspaceFolder));
  const reveal = shellBridge()?.revealPath;
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
      <span className="font-mono text-[11px]">
        {path}
        {suffix}
      </span>
      {reveal && location ? (
        <span className="text-2xs text-fg-tertiary">Click to show in File Explorer</span>
      ) : null}
    </span>
  );
  const chip = (
    <Tooltip label={label} side="top">
      {reveal && location ? (
        <button
          type="button"
          onClick={() => void reveal(location)}
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
  const act = reveal || (mention && messageBox);
  return (
    <ContextMenuArea
      menu={
        <>
          {reveal ? (
            <MenuItem icon={FolderOpen} onClick={() => void reveal(location)}>
              Show in File Explorer
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
