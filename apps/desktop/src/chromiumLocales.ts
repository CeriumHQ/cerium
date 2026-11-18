import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The compact release artifact corresponding to a full-locale artifact. */
export const englishArtifact = (name: string): string => name.replace(/^cerium(?=[-_])/i, "$&-english");

export const isEnglishArtifact = (name: string): boolean => /^cerium-english[-_]/i.test(name);

/**
 * Use the matching compact file for each installer when available. Keep the full file if the
 * release predates compact builds or only has the compact installer for a different architecture.
 */
export const localeUpdateFiles = <T extends { readonly url: string }>(files: readonly T[]): T[] => {
  const byName = new Map(files.map((file) => [file.url, file]));
  return files
    .filter((file) => !isEnglishArtifact(file.url))
    .map((file) => byName.get(englishArtifact(file.url)) ?? file);
};

/** The installer records its locale selection in the packaged app's metadata. */
export const hasEnglishLocalesOnly = (appPath: string): boolean => {
  const metadata = JSON.parse(readFileSync(join(appPath, "package.json"), "utf8")) as {
    chromiumLocales?: string;
  };
  return metadata.chromiumLocales === "english";
};
