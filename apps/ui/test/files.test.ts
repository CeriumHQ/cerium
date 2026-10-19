import type { AgentEvent, AgentId, EventId, ThreadId } from "@cerium/protocol";
import type { FileEntry, FileStatuses } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  ancestors,
  buildRows,
  changedRows,
  indexChanges,
  keyAction,
  noChanges,
  parentIndex,
  stateAt,
  touchedFiles,
  typeAhead,
  type Listed,
  type Row,
} from "../src/features/files/model.ts";

const entry = (name: string, folder = false, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  folder,
  ...extra,
});

const statuses = (...changes: FileStatuses["changes"][number][]): FileStatuses => ({
  repository: true,
  changes,
});

describe("indexChanges", () => {
  it("rolls what changed up into the folders above it", () => {
    const index = indexChanges(
      statuses(
        { path: "src/ui/a.ts", state: "added" },
        { path: "src/ui/b.ts", state: "modified" },
        { path: "src/c.ts", state: "untracked" },
      ),
    );
    expect(index.rollups.get("src/ui")).toEqual({ state: "modified", count: 2 });
    expect(index.rollups.get("src")).toEqual({ state: "modified", count: 3 });
    expect(index.rollups.has("src/ui/a.ts")).toBe(false);
  });

  it("lets what needs attention most stand for a folder", () => {
    const state = (...states: Array<"conflicted" | "modified" | "deleted" | "added" | "untracked">) =>
      indexChanges(statuses(...states.map((each, at) => ({ path: `d/${at}`, state: each }))));
    expect(state("untracked", "added").rollups.get("d")?.state).toBe("added");
    expect(state("added", "deleted").rollups.get("d")?.state).toBe("deleted");
    expect(state("deleted", "modified").rollups.get("d")?.state).toBe("modified");
    expect(state("modified", "conflicted", "added").rollups.get("d")?.state).toBe("conflicted");
  });

  it("says nothing outside a repository", () => {
    expect(indexChanges({ repository: false, changes: [] })).toBe(noChanges);
    expect(indexChanges(undefined)).toBe(noChanges);
  });

  it("takes everything inside a folder git hasn't seen as new", () => {
    const index = indexChanges(
      statuses({ path: "fresh/", state: "untracked" }, { path: "a.ts", state: "modified" }),
    );
    expect(stateAt(index, "fresh")).toBe("untracked");
    expect(stateAt(index, "fresh/deep/file.ts")).toBe("untracked");
    expect(stateAt(index, "a.ts")).toBe("modified");
    expect(stateAt(index, "b.ts")).toBeUndefined();
    expect(index.rollups.get("fresh")).toBeUndefined();
  });
});

describe("ancestors", () => {
  it("lists the folders above a path, outermost first", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
  });
});

describe("buildRows", () => {
  const listings: Record<string, Listed> = {
    "": {
      entries: [
        entry("src", true),
        entry("node_modules", true, { heavy: true, ignored: true }),
        entry("a.ts"),
      ],
    },
    src: { entries: [entry("ui", true), entry("b.ts")] },
    "src/ui": { entries: [entry("App.tsx")] },
  };
  const listing = (dir: string): Listed => listings[dir] ?? "loading";
  const paths = (rows: ReadonlyArray<Row>) => rows.map((row) => `${"  ".repeat(row.depth)}${row.name}`);

  it("lists the top level with folders closed", () => {
    const rows = buildRows({ expanded: new Set(), listing, changes: noChanges });
    expect(paths(rows)).toEqual(["src", "node_modules", "a.ts"]);
    expect(rows[1]).toMatchObject({ heavy: true, ignored: true, folder: true, expanded: false });
  });

  it("lists what is inside the folders that are open, beneath them", () => {
    const rows = buildRows({ expanded: new Set(["src", "src/ui"]), listing, changes: noChanges });
    expect(paths(rows)).toEqual(["src", "  ui", "    App.tsx", "  b.ts", "node_modules", "a.ts"]);
    expect(rows[2]).toMatchObject({ path: "src/ui/App.tsx", depth: 2 });
  });

  it("marks a folder that is open before its entries arrive as loading", () => {
    const rows = buildRows({ expanded: new Set(["node_modules"]), listing, changes: noChanges });
    expect(rows[1]).toMatchObject({ expanded: true, loading: true });
    expect(rows).toHaveLength(3);
  });

  it("carries each file's state and each folder's roll-up", () => {
    const changes = indexChanges(statuses({ path: "src/ui/App.tsx", state: "modified" }));
    const rows = buildRows({ expanded: new Set(["src", "src/ui"]), listing, changes });
    expect(rows.find((row) => row.name === "App.tsx")?.state).toBe("modified");
    expect(rows.find((row) => row.name === "src")?.rollup).toEqual({ state: "modified", count: 1 });
    expect(rows.find((row) => row.name === "b.ts")?.state).toBeUndefined();
  });

  it("lists a deleted file where it was, and a deleted folder whole", () => {
    const changes = indexChanges(
      statuses({ path: "src/old.ts", state: "deleted" }, { path: "legacy/a/b.ts", state: "deleted" }),
    );
    const rows = buildRows({
      expanded: new Set(["src", "legacy", "legacy/a"]),
      listing: (dir) => listings[dir] ?? { entries: [] },
      changes,
    });
    expect(paths(rows)).toEqual([
      "legacy",
      "  a",
      "    b.ts",
      "node_modules",
      "src",
      "  ui",
      "  b.ts",
      "  old.ts",
      "a.ts",
    ]);
    const old = rows.find((row) => row.path === "src/old.ts");
    expect(old).toMatchObject({ gone: true, state: "deleted", folder: false });
    const legacy = rows.find((row) => row.path === "legacy");
    expect(legacy).toMatchObject({ gone: true, folder: true, expanded: true });
    expect(rows.find((row) => row.path === "legacy/a/b.ts")).toMatchObject({ gone: true, depth: 2 });
    // Folders still come first.
    expect(rows.findIndex((row) => row.path === "legacy")).toBeLessThan(
      rows.findIndex((row) => row.path === "src"),
    );
  });
});

describe("touchedFiles", () => {
  const changed = (path: string, change: "created" | "modified" | "deleted", at: number): AgentEvent => ({
    id: `evt_${at}` as EventId,
    threadId: "thr_1" as ThreadId,
    agentId: "agt_1" as AgentId,
    sequence: at,
    at,
    payload: { _tag: "FileChanged", path, change },
  });

  it("names files inside the folder, whether the agent wrote them absolute or relative", () => {
    const touched = touchedFiles(
      [
        changed("C:\\work\\app\\src\\a.ts", "modified", 1),
        changed("src/b.ts", "created", 2),
        changed("D:\\elsewhere\\c.ts", "modified", 3),
      ],
      "C:\\work\\app",
    );
    expect([...touched.files.values()].map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(touched.folders.has("src")).toBe(true);
  });

  it("ignores case on Windows paths only", () => {
    const windows = touchedFiles([changed("C:\\WORK\\APP\\Src\\A.ts", "modified", 1)], "c:/work/app");
    expect(windows.files.has("src/a.ts")).toBe(true);
    expect(windows.insensitive).toBe(true);
    const other = touchedFiles([changed("/work/app/src/A.ts", "modified", 1)], "/work/app");
    expect(other.files.has("src/A.ts")).toBe(true);
    expect(other.files.has("src/a.ts")).toBe(false);
  });

  it("keeps a file the agents made as made after they edit it", () => {
    const touched = touchedFiles([changed("a.ts", "created", 1), changed("a.ts", "modified", 2)], "/work");
    expect(touched.files.get("a.ts")?.change).toBe("created");
    const removed = touchedFiles([changed("a.ts", "created", 1), changed("a.ts", "deleted", 2)], "/work");
    expect(removed.files.get("a.ts")?.change).toBe("deleted");
  });
});

describe("changedRows", () => {
  it("lists what git says, new folders whole, and what the agents touched that git doesn't mention", () => {
    const changes = indexChanges(
      statuses(
        { path: "src/a.ts", state: "modified" },
        { path: "fresh/", state: "untracked" },
        { path: "gone.ts", state: "deleted" },
      ),
    );
    const edits: ReadonlyArray<{ path: string; change: "created" | "modified" | "deleted" }> = [
      { path: "/w/src/a.ts", change: "modified" },
      { path: "/w/committed.ts", change: "modified" },
      { path: "/w/fresh/inside.ts", change: "created" },
      { path: "/w/removed.ts", change: "deleted" },
    ];
    const touched = touchedFiles(
      edits.map(({ path, change }, at) => ({
        id: `evt_${at}` as EventId,
        threadId: "thr_1" as ThreadId,
        agentId: "agt_1" as AgentId,
        sequence: at,
        at,
        payload: { _tag: "FileChanged" as const, path, change },
      })),
      "/w",
    );
    expect(changedRows(changes, touched)).toEqual([
      { path: "committed.ts", folder: false, touch: "modified" },
      { path: "fresh", folder: true, state: "untracked" },
      { path: "gone.ts", folder: false, state: "deleted" },
      { path: "src/a.ts", folder: false, state: "modified", touch: "modified" },
    ]);
  });
});

describe("keyboard", () => {
  const row = (path: string, folder = false, expanded = false): Row => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    depth: path.split("/").length - 1,
    folder,
    expanded,
    loading: false,
    ignored: false,
    heavy: false,
    link: false,
    gone: false,
  });
  const rows = [
    row("api", true, true),
    row("api/routes.ts"),
    row("api/server.ts"),
    row("docs", true),
    row("README.md"),
  ];

  it("moves between rows and to either end", () => {
    expect(keyAction(rows, 0, "ArrowDown")).toEqual({ kind: "focus", index: 1 });
    expect(keyAction(rows, 4, "ArrowDown")).toBeUndefined();
    expect(keyAction(rows, 1, "ArrowUp")).toEqual({ kind: "focus", index: 0 });
    expect(keyAction(rows, 0, "ArrowUp")).toBeUndefined();
    expect(keyAction(rows, 2, "Home")).toEqual({ kind: "focus", index: 0 });
    expect(keyAction(rows, 2, "End")).toEqual({ kind: "focus", index: 4 });
  });

  it("opens and closes folders, and steps in and out of them", () => {
    expect(keyAction(rows, 3, "ArrowRight")).toEqual({ kind: "expand", path: "docs" });
    expect(keyAction(rows, 0, "ArrowRight")).toEqual({ kind: "focus", index: 1 });
    expect(keyAction(rows, 0, "ArrowLeft")).toEqual({ kind: "collapse", path: "api" });
    expect(keyAction(rows, 2, "ArrowLeft")).toEqual({ kind: "focus", index: 0 });
    expect(keyAction(rows, 4, "ArrowLeft")).toBeUndefined();
    expect(keyAction(rows, 4, "ArrowRight")).toBeUndefined();
  });

  it("opens a file and toggles a folder with Enter", () => {
    expect(keyAction(rows, 4, "Enter")).toEqual({ kind: "open", path: "README.md" });
    expect(keyAction(rows, 3, "Enter")).toEqual({ kind: "toggle", path: "docs" });
    expect(keyAction(rows, 3, "x")).toBeUndefined();
  });

  it("finds the folder a row is in", () => {
    expect(parentIndex(rows, 2)).toBe(0);
    expect(parentIndex(rows, 0)).toBeUndefined();
    expect(parentIndex(rows, 4)).toBeUndefined();
  });

  it("jumps to the next name that begins with what was typed", () => {
    expect(typeAhead(rows, 0, "s")).toBe(2);
    expect(typeAhead(rows, 0, "d")).toBe(3);
    expect(typeAhead(rows, -1, "api")).toBe(0);
    expect(typeAhead(rows, 0, "rou")).toBe(1);
    expect(typeAhead(rows, 4, "a")).toBe(0);
    expect(typeAhead(rows, 0, "zz")).toBeUndefined();
    expect(typeAhead([], 0, "a")).toBeUndefined();
  });

  it("steps through names with the same first letter when it is typed again", () => {
    const names = [row("alpha.ts"), row("apple.ts"), row("beta.ts")];
    expect(typeAhead(names, 0, "a")).toBe(1);
    expect(typeAhead(names, 1, "aa")).toBe(0);
  });
});
