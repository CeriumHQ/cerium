import { describe, expect, it } from "@effect/vitest";

import { imageType, rankEntries, safeFileName, withFolders } from "../src/workspace.ts";

const entries = withFolders([
  "README.md",
  "apps/ui/src/features/transcript/Transcript.tsx",
  "apps/ui/src/features/transcript/model.ts",
  "apps/ui/test/transcript.test.ts",
  "packages/protocol/src/events.ts",
]);

const paths = (query: string) => rankEntries(entries, query, 10).map((entry) => entry.path);

describe("rankEntries", () => {
  it("offers the folder's top level, folders first, before anything is typed", () => {
    expect(paths("")).toEqual(["apps", "packages", "README.md"]);
  });

  it("puts names before paths, and shallow before deep", () => {
    expect(paths("transcript")).toEqual([
      "apps/ui/src/features/transcript",
      "apps/ui/test/transcript.test.ts",
      "apps/ui/src/features/transcript/Transcript.tsx",
      "apps/ui/src/features/transcript/model.ts",
    ]);
  });

  it("matches characters in order across the path", () => {
    expect(paths("protev")).toEqual(["packages/protocol/src/events.ts"]);
    expect(paths("zzz")).toEqual([]);
  });
});

describe("withFolders", () => {
  it("lists every folder above the files once", () => {
    expect(withFolders(["a/b/c.ts", "a/d.ts"])).toEqual([
      { path: "a", folder: true },
      { path: "a/b", folder: true },
      { path: "a/b/c.ts", folder: false },
      { path: "a/d.ts", folder: false },
    ]);
  });
});

describe("attachments", () => {
  it("keeps a pasted file's name safe on disk", () => {
    expect(safeFileName("image.png")).toBe("image.png");
    expect(safeFileName('a<b>:"c"/d\\e|f?.txt')).toBe("a_b___c__d_e_f_.txt");
    expect(safeFileName(" .. ")).toBe("attachment");
  });

  it("recognises images by extension", () => {
    expect(imageType("C:/shots/Screen.PNG")).toBe("image/png");
    expect(imageType("photo.jpeg")).toBe("image/jpeg");
    expect(imageType("notes.md")).toBeUndefined();
  });
});
