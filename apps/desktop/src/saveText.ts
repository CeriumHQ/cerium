import { app, BrowserWindow, dialog, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Saves a thread's export (Markdown or plain text), where the user picks with the native Save dialog.

/** The file types a thread export is written as. */
const formats = {
  markdown: { label: "Markdown document", extensions: ["md"] },
  text: { label: "Plain text", extensions: ["txt"] },
} as const;

/**
 * Where the Save dialog opens: Documents at first, then wherever the user last saved a document. Left to
 * Windows, a first save opens in the folder Cerium was started from.
 */
let saveFolder: string | undefined;

/**
 * Asks where to save `text`, suggesting `name`, in `format` ("markdown" or "text"), then writes it as
 * UTF-8. Resolves whether it was saved.
 */
export const saveText = async (
  sender: WebContents,
  text: unknown,
  name: unknown,
  format: unknown,
): Promise<boolean> => {
  if (typeof text !== "string" || typeof name !== "string") return false;
  if (format !== "markdown" && format !== "text") return false;
  const type = formats[format];
  const fileName = basename(name).trim() || `conversation.${type.extensions[0]}`;
  const options = {
    defaultPath: join(saveFolder ?? app.getPath("documents"), fileName),
    filters: [{ name: type.label, extensions: [...type.extensions] }],
  };
  const owner = BrowserWindow.fromWebContents(sender);
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || result.filePath === "") return false;
  saveFolder = dirname(result.filePath);
  await writeFile(result.filePath, text, "utf8");
  return true;
};
