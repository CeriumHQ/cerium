import type { TextCommand, TextMenuRequest } from "../backend/shell.ts";

/** One item of the app-wide text menu. */
export interface TextMenuEntry {
  readonly command: TextCommand;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The text menu's groups for a right-click, only those that apply: editing, then copying read-only
 * text, then the link. None means no menu.
 */
export const textMenuGroups = (request: TextMenuRequest): ReadonlyArray<ReadonlyArray<TextMenuEntry>> => {
  const groups: Array<ReadonlyArray<TextMenuEntry>> = [];
  if (request.editable) {
    groups.push([
      { command: { kind: "cut" }, label: "Cut", disabled: !request.canCut },
      { command: { kind: "copy" }, label: "Copy", disabled: !request.canCopy },
      { command: { kind: "paste" }, label: "Paste", disabled: !request.canPaste },
      { command: { kind: "selectAll" }, label: "Select all", disabled: !request.canSelectAll },
    ]);
  } else if (request.selection) {
    groups.push([{ command: { kind: "copySelection" }, label: "Copy" }]);
  }
  if (request.link) {
    groups.push([
      ...(request.link.openable ? [{ command: { kind: "openLink" as const }, label: "Open link" }] : []),
      { command: { kind: "copyLink" }, label: "Copy link address" },
    ]);
  }
  return groups;
};
