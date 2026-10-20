import { app, shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Opens an agent's artifact, a page of its own, in the user's browser: written to a file in Cerium's
// temporary folder, which the browser opens from disk.

/** The most an opened page may weigh; artifacts with embedded images run to a few megabytes. */
const MAX_BYTES = 20 * 1024 * 1024;

/** A file name for `name`: no path, nothing Windows refuses, and short. */
const fileName = (name: string): string =>
  (name
    // Control characters are among what Windows refuses in a file name.
    // oxlint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Artifact") + ".html";

export const openHtml = async (html: unknown, name: unknown): Promise<void> => {
  if (typeof html !== "string" || typeof name !== "string" || html.length > MAX_BYTES) return;
  const folder = join(app.getPath("temp"), "Cerium artifacts");
  await mkdir(folder, { recursive: true });
  const file = join(folder, fileName(name));
  await writeFile(file, html, "utf8");
  await shell.openExternal(pathToFileURL(file).href);
};
