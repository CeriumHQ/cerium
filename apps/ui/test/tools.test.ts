import { describe, expect, it } from "@effect/vitest";

import { describeTool, toolImages, toolMenuPlan } from "../src/features/transcript/ToolGroup.tsx";

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

describe("toolMenuPlan", () => {
  const plan = (toolName: string, input: unknown, output?: unknown) =>
    toolMenuPlan({ kind: "tool", id: "tool:1", toolName, input, output, status: "done", changedFiles: [] });

  it("copies the command, pattern or query a call is about", () => {
    expect(plan("Bash", { command: "ls -la" }, "total 0")).toEqual({
      copy: { label: "Copy command", text: "ls -la" },
      output: "total 0",
    });
    expect(plan("Grep", { pattern: "TODO" })).toEqual({ copy: { label: "Copy pattern", text: "TODO" } });
    expect(plan("WebSearch", { query: "effect 4" })).toEqual({
      copy: { label: "Copy query", text: "effect 4" },
    });
  });

  it("names the file of file tools, and of a patch that touches one", () => {
    expect(plan("Read", { file_path: "src/a.ts" })).toEqual({
      copy: { label: "Copy path", text: "src/a.ts" },
      path: "src/a.ts",
    });
    expect(plan("apply_patch", { changes: [{ path: "C:\\w\\out.txt" }] }).path).toBe("C:\\w\\out.txt");
    // Two files have no single path, so the input is what's left to copy.
    expect(plan("apply_patch", { changes: [{ path: "a" }, { path: "b" }] }).copy?.label).toBe("Copy input");
  });

  it("opens only https pages", () => {
    expect(plan("WebFetch", { url: "https://example.com/a" })).toEqual({
      copy: { label: "Copy URL", text: "https://example.com/a" },
      url: "https://example.com/a",
    });
    expect(plan("WebFetch", { url: "http://example.com" }).url).toBeUndefined();
  });

  it("copies the input of MCP and unknown tools, and nothing for a call without any", () => {
    expect(plan("mcp__cerium__spawn_agent", { role: "x" }).copy).toEqual({
      label: "Copy input",
      text: JSON.stringify({ role: "x" }, null, 2),
    });
    expect(plan("sleep", undefined)).toEqual({});
  });

  it("copies the output as the panel shows it, with blobs elided, and not when images replace it", () => {
    const blob = "A".repeat(4096);
    expect(plan("mcp__x__y", {}, { data: blob }).output).toBe(
      JSON.stringify({ data: "[3 KB of base64]" }, null, 2),
    );
    expect(
      plan("Read", { file_path: "C:\\w\\shot.png" }, [
        { type: "image", source: { media_type: "image/png", data: "iVBORw0K" } },
      ]).output,
    ).toBeUndefined();
  });
});
