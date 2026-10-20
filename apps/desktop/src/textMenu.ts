import { clipboard, shell, type ContextMenuParams, type WebContents } from "electron";

// The app-wide text menu. Chromium reports each right-click no page menu
// claimed; the page draws Cerium's own menu for it and names a command, which the shell runs here on
// what that right-click was on. The page never hands back a word, text or link to act on.

const lastRightClick = new WeakMap<WebContents, ContextMenuParams>();

const isHttps = (url: string) => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Cut, Copy and Paste act on the focused frame, which the menu itself moves to the page, so only a
 * field in the page itself counts as editable; an artifact's frame offers what needs no focus.
 */
const requestOf = (contents: WebContents, params: ContextMenuParams) => {
  const inPage = params.frame === null || params.frame === contents.mainFrame;
  const editable = params.isEditable && inPage;
  return {
    x: params.x,
    y: params.y,
    editable,
    canCut: params.editFlags.canCut,
    canCopy: params.editFlags.canCopy,
    canPaste: params.editFlags.canPaste,
    canSelectAll: params.editFlags.canSelectAll,
    selection: params.selectionText.trim() !== "",
    ...(params.linkURL === "" ? {} : { link: { openable: isHttps(params.linkURL) } }),
  };
};

/** Reports every right-click `contents` leaves to the shell to the page, which shows the menu. */
export const forwardTextMenus = (contents: WebContents) => {
  contents.on("context-menu", (_event, params) => {
    lastRightClick.set(contents, params);
    contents.send("cerium:text-menu", requestOf(contents, params));
  });
};

/** Runs a text menu command the page sent on the last right-click it was told about. */
export const runTextCommand = (contents: WebContents, command: unknown) => {
  const params = lastRightClick.get(contents);
  if (params === undefined || typeof command !== "object" || command === null) return;
  const kind = "kind" in command ? command.kind : undefined;
  // Anything else is ignored.
  switch (kind) {
    case "cut":
      return contents.cut();
    case "copy":
      return contents.copy();
    case "paste":
      return contents.paste();
    case "selectAll":
      return contents.selectAll();
    case "copySelection":
      if (params.selectionText !== "") void clipboard.writeText(params.selectionText);
      return;
    case "openLink":
      if (isHttps(params.linkURL)) void shell.openExternal(params.linkURL);
      return;
    case "copyLink":
      if (params.linkURL !== "") void clipboard.writeText(params.linkURL);
      return;
  }
};
