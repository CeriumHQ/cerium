import { describe, expect, it } from "@effect/vitest";

import { describeTool, toolImages } from "../src/features/transcript/ToolGroup.tsx";

const describeCall = (toolName: string, input: unknown) => {
  const { verb, detail } = describeTool({
    kind: "tool",
    id: "tool:1",
    toolName,
    input,
    status: "done",
    changedFiles: [],
  });
  return { verb, detail };
};

describe("describeTool", () => {
  it("reads every harness's file tools alike", () => {
    expect(describeCall("Read", { file_path: "/w/src/a.ts" })).toEqual({ verb: "Read", detail: "a.ts" });
    expect(describeCall("read", { path: "C:\\w\\a.ts" })).toEqual({ verb: "Read", detail: "a.ts" });
    expect(describeCall("write_file", { path: "out.txt", content: "HI" })).toEqual({
      verb: "Write",
      detail: "out.txt",
    });
    expect(describeCall("edit_file", { path: "b.ts" })).toEqual({ verb: "Edit", detail: "b.ts" });
    expect(describeCall("delete", { path: "c.ts" })).toEqual({ verb: "Delete", detail: "c.ts" });
  });

  it("names the files a patch touches, from Codex's changes or Muse's patch text", () => {
    expect(
      describeCall("apply_patch", { changes: [{ path: "C:\\w\\out.txt", kind: { type: "add" } }] }),
    ).toEqual({
      verb: "Edit",
      detail: "out.txt",
    });
    expect(
      describeCall("apply_patch", {
        patch: "*** Begin Patch\n*** Add File: a.ts\n*** Update File: b.ts\n*** End Patch",
      }),
    ).toEqual({ verb: "Edit", detail: "2 files" });
  });

  it("shows the command, pattern or query a call ran", () => {
    expect(describeCall("exec_command", { command: "Get-Content hello.txt" })).toEqual({
      verb: "Run",
      detail: "Get-Content hello.txt",
    });
    expect(describeCall("shell", { command: "ls" })).toEqual({ verb: "Run", detail: "ls" });
    expect(describeCall("glob", { globPattern: "**/*.ts" })).toEqual({ verb: "Search", detail: "**/*.ts" });
    expect(describeCall("web_search", { query: "effect 4" })).toEqual({
      verb: "Search the web",
      detail: "effect 4",
    });
  });

  it("keeps MCP tools and unknown tools readable", () => {
    expect(describeCall("mcp__cerium__spawn_agent", {})).toEqual({ verb: "spawn agent", detail: "cerium" });
    expect(describeCall("sleep", {})).toEqual({ verb: "sleep", detail: undefined });
  });
});

describe("toolImages", () => {
  const call = (toolName: string, input: unknown, output: unknown) =>
    toolImages({ kind: "tool", id: "tool:1", toolName, input, output, status: "done", changedFiles: [] });

  it("shows an image the tool returned", () => {
    expect(
      call("Read", { file_path: "C:\\w\\shot.png" }, [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      ]),
    ).toEqual([{ key: "tool:1:0", name: "shot.png", url: "data:image/png;base64,iVBORw0K" }]);
    expect(
      call(
        "mcp__browser__screenshot",
        {},
        { content: [{ type: "image", data: "R0lG", mimeType: "image/gif" }] },
      ),
    ).toEqual([{ key: "tool:1:0", name: "Image", url: "data:image/gif;base64,R0lG" }]);
  });

  it("reads the file again for harnesses that only report its path", () => {
    expect(call("view_image", { path: "/w/diagram.webp" }, { path: "/w/diagram.webp" })).toEqual([
      { key: "tool:1", name: "diagram.webp", path: "/w/diagram.webp" },
    ]);
    expect(call("image_generation", { prompt: "a cat" }, { savedPath: "C:\\out\\cat.png" })).toEqual([
      { key: "tool:1", name: "cat.png", path: "C:\\out\\cat.png" },
    ]);
  });

  it("shows nothing for other files or paths it can't resolve", () => {
    expect(call("Read", { file_path: "/w/a.ts" }, "export {}")).toEqual([]);
    expect(call("read", { path: "shot.png" }, "binary")).toEqual([]);
  });
});
