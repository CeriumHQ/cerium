import { describe, expect, it } from "vite-plus/test";

import { mergeUpdateFiles } from "../merge-update-files.ts";

const updateFile = (arch: string, size: number) =>
  [
    "version: 1.2.0",
    "files:",
    `  - url: Cerium-Setup-1.2.0-${arch}.exe`,
    `    sha512: ${arch}-hash`,
    `    size: ${size}`,
    `path: Cerium-Setup-1.2.0-${arch}.exe`,
    `sha512: ${arch}-hash`,
    "releaseDate: '2026-10-23T00:00:00.000Z'",
    "",
  ].join("\n");

describe("mergeUpdateFiles", () => {
  it("lists every processor's installer and keeps x64's for older updaters", () => {
    expect(mergeUpdateFiles([updateFile("arm64", 2), updateFile("x64", 1)])).toBe(
      [
        "version: 1.2.0",
        "files:",
        "  - url: Cerium-Setup-1.2.0-x64.exe",
        "    sha512: x64-hash",
        "    size: 1",
        "  - url: Cerium-Setup-1.2.0-arm64.exe",
        "    sha512: arm64-hash",
        "    size: 2",
        "path: Cerium-Setup-1.2.0-x64.exe",
        "sha512: x64-hash",
        "releaseDate: '2026-10-23T00:00:00.000Z'",
        "",
      ].join("\n"),
    );
  });

  it("lists a file both list once, and reads Windows line endings", () => {
    const merged = mergeUpdateFiles([updateFile("x64", 1).replace(/\n/g, "\r\n"), updateFile("x64", 1)]);
    expect(merged.match(/- url:/g)).toHaveLength(1);
  });

  it("refuses files of different versions", () => {
    expect(() =>
      mergeUpdateFiles([updateFile("x64", 1), updateFile("arm64", 2).replace("1.2.0\n", "1.3.0\n")]),
    ).toThrow(/different versions/);
  });
});
