import type { WorkspaceEntry } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  imageType,
  rankEntries,
  safeFileName,
  searchable,
  withFolders,
  Workspace,
} from "../src/workspace.ts";

const entries = searchable(
  withFolders([
    "README.md",
    "apps/ui/src/features/transcript/Transcript.tsx",
    "apps/ui/src/features/transcript/model.ts",
    "apps/ui/test/transcript.test.ts",
    "packages/protocol/src/events.ts",
  ]),
);

const paths = (query: string) => rankEntries(entries, query, 10).map((entry) => entry.path);

/** The ranking as it was first written, sorting every match: what `rankEntries` must still give. */
const rankedBySorting = (list: ReadonlyArray<WorkspaceEntry>, query: string, limit: number) => {
  const depth = (path: string) => path.split("/").length;
  const wanted = query.trim().toLowerCase().replaceAll("\\", "/");
  const score = (entry: WorkspaceEntry) => {
    const path = entry.path.toLowerCase();
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === wanted) return 0;
    if (name.startsWith(wanted)) return 1;
    if (name.includes(wanted)) return 2;
    if (path.includes(wanted)) return 3;
    let at = 0;
    for (const char of wanted) {
      at = path.indexOf(char, at);
      if (at === -1) return undefined;
      at++;
    }
    return 4;
  };
  return list
    .flatMap((entry) => {
      const rank = score(entry);
      return rank === undefined ? [] : [{ entry, rank }];
    })
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        depth(a.entry.path) - depth(b.entry.path) ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
};

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

  it("ranks a long listing as sorting every match would, ties in the listing's order", () => {
    // Names that differ only in case, that collate alike (é written whole and as e and its accent),
    // and the same path twice, so many matches tie on everything but where they are listed.
    const parts = [
      "src",
      "Src",
      "app",
      "a",
      "é",
      "é".normalize("NFD"),
      "index.ts",
      "Index.ts",
      "tab.tsx",
      "readme.md",
    ];
    let seed = 7;
    const next = (below: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % below;
    };
    const list: Array<WorkspaceEntry> = [];
    for (let count = 0; count < 3_000; count++) {
      const path = Array.from({ length: 1 + next(4) }, () => parts[next(parts.length)]!).join("/");
      list.push({ path, folder: next(2) === 0 });
      if (next(10) === 0) list.push({ path, folder: next(2) === 0 });
    }
    const prepared = searchable(list);
    // Where each entry is listed, so equal entries in a different order still tell apart.
    const places = (ranked: ReadonlyArray<WorkspaceEntry>) => ranked.map((entry) => list.indexOf(entry));
    for (const query of ["a", "s", "in", "index", "É", "e", "ts", "src/a", " A\\é ", "zz"]) {
      for (const limit of [1, 7, 50, 10_000]) {
        expect(places(rankEntries(prepared, query, limit)), `${query} ${limit}`).toEqual(
          places(rankedBySorting(list, query, limit)),
        );
      }
    }
  });
});

describe("Workspace.search", () => {
  // Making a link on Windows takes a right most accounts don't have.
  it.effect.skipIf(process.platform === "win32")(
    "walks a folder outside git, links as what they lead to, past dependencies and broken links",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const attachmentsDirectory = yield* fs.makeTempDirectoryScoped();
        for (const file of ["b.txt", "a/deep/c.txt", "node_modules/dep/index.js", "real/d.txt"]) {
          yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
          yield* fs.writeFileString(path.join(root, file), "x");
        }
        yield* fs.symlink(path.join(root, "real"), path.join(root, "linked"));
        yield* fs.symlink(path.join(root, "gone"), path.join(root, "broken"));
        const [top, texts, deps] = yield* Effect.gen(function* () {
          const workspace = yield* Workspace;
          return yield* Effect.forEach(["", "txt", "dep"], (query) => workspace.search(root, query, 100));
        }).pipe(
          Effect.provide(
            Workspace.layer({ attachmentsDirectory }).pipe(
              Layer.provide(Store.layer({ filename: ":memory:" })),
            ),
          ),
        );
        assert.deepStrictEqual(top, [
          { path: "a", folder: true },
          { path: "linked", folder: true },
          { path: "real", folder: true },
          { path: "b.txt", folder: false },
        ]);
        assert.deepStrictEqual(texts!.map((entry) => entry.path).toSorted(), [
          "a/deep/c.txt",
          "b.txt",
          "linked/d.txt",
          "real/d.txt",
        ]);
        assert.deepStrictEqual(deps!.map((entry) => entry.path).toSorted(), ["a/deep", "a/deep/c.txt"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
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
