import { REMOVED_IMAGE } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  describeTool,
  exitCodeOf,
  failureLine,
  hasToolMenu,
  outputText,
  sameTool,
  shownImages,
  summarizeTools,
  toolImages,
  toolInputView,
  toolMenuPlan,
  withoutExitLine,
  type ToolBlock,
} from "../src/features/transcript/tools.ts";

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

  it("reads OpenCode's patch, fetch and search tools", () => {
    expect(
      describeCall("patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }),
    ).toEqual({ verb: "Edit", detail: "a.ts" });
    expect(describeCall("webfetch", { url: "https://opencode.ai", format: "markdown" })).toMatchObject({
      detail: "https://opencode.ai",
    });
    expect(describeCall("websearch", { query: "effect 4" })).toEqual({
      verb: "Search the web",
      detail: "effect 4",
    });
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

  it("prefers the agent's own account of a command to the command", () => {
    expect(describeCall("Bash", { command: "bun run typecheck", description: "Typecheck the repo" })).toEqual(
      { verb: "Run", detail: "Typecheck the repo" },
    );
  });

  it("keeps MCP tools and unknown tools readable", () => {
    expect(describeCall("mcp__cerium__spawn_agent", {})).toEqual({ verb: "Spawn agent", detail: "cerium" });
    expect(describeCall("mcp__cerium__ui_act", { steps: [] })).toEqual({ verb: "UI act", detail: "cerium" });
    expect(describeCall("mcp__cerium__ui_open", { url: "http://localhost:5173" })).toEqual({
      verb: "UI open",
      detail: "http://localhost:5173",
    });
    expect(describeCall("sleep", {})).toEqual({ verb: "Sleep", detail: undefined });
    expect(describeCall("view_image", { path: "a.png" })).toEqual({ verb: "View image", detail: "a.png" });
  });

  it("names the harness's own helper tools by what they do", () => {
    expect(describeCall("Skill", { skill: "run", args: "x" })).toEqual({ verb: "Use skill", detail: "run" });
    expect(describeCall("ToolSearch", { query: "select:Monitor", max_results: 1 })).toEqual({
      verb: "Load tools",
      detail: "Monitor",
    });
    expect(describeCall("TodoWrite", { todos: [] })).toEqual({ verb: "Update plan", detail: undefined });
    expect(
      describeCall("ToolSearch", { query: "select:mcp__cerium__ui_open,mcp__ccd_session__list_sessions" }),
    ).toEqual({ verb: "Load tools", detail: "ui_open, list_sessions" });
    expect(
      describeCall("mcp__cerium__spawn_agent", { role: "pr-scout", model: "scout", prompt: "List PRs" }),
    ).toEqual({ verb: "Spawn agent", detail: "pr-scout" });
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

  it("marks an image its thread's slimming removed, which has no pictures left to show", () => {
    const tool: ToolBlock = {
      kind: "tool",
      id: "tool:1",
      toolName: "mcp__browser__screenshot",
      input: {},
      output: {
        content: [
          { type: "image", data: REMOVED_IMAGE, mimeType: "image/png" },
          { type: "image", data: "R0lG", mimeType: "image/gif" },
        ],
      },
      status: "done",
      changedFiles: [],
    };
    expect(toolImages(tool)).toEqual([
      { key: "tool:1:0", name: "Image (1)", removed: true },
      { key: "tool:1:1", name: "Image (2)", url: "data:image/gif;base64,R0lG" },
    ]);
    expect(shownImages(tool).map((image) => image.key)).toEqual(["tool:1:1"]);
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

  it("is offered whenever it has something, which a row tells without laying the output out", () => {
    const image = [{ type: "image", source: { media_type: "image/png", data: "iVBORw0K" } }];
    const calls: ReadonlyArray<ToolBlock> = [
      ["Bash", { command: "ls" }, "total 0"],
      ["Read", { file_path: "a.ts" }],
      ["sleep", undefined],
      ["sleep", undefined, "done"],
      ["sleep", undefined, image],
    ].map(([toolName, input, output]) => ({
      kind: "tool",
      id: "tool:1",
      toolName: toolName as string,
      input,
      output,
      status: "done",
      changedFiles: [],
    }));
    const offered = calls.map((call) => {
      const { copy, output } = toolMenuPlan(call);
      return copy !== undefined || output !== undefined;
    });
    expect(offered).toEqual([true, true, false, true, false]);
    expect(calls.map(hasToolMenu)).toEqual(offered);
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

const toolCall = (toolName: string, input: unknown, output?: unknown, status: ToolBlock["status"] = "done") =>
  ({ kind: "tool", id: "tool:1", toolName, input, output, status, changedFiles: [] }) satisfies ToolBlock;

describe("sameTool", () => {
  it("finds a call rebuilt from the same events unchanged, and one that moved on changed", () => {
    const input = { command: "ls" };
    const output = [{ type: "text", text: "total 0" }];
    const call = { ...toolCall("Bash", input, output), changedFiles: ["a.ts"] };
    expect(sameTool(call, { ...call, changedFiles: ["a.ts"] })).toBe(true);
    expect(sameTool(call, { ...call, status: "error" })).toBe(false);
    expect(sameTool(call, { ...call, changedFiles: ["a.ts", "b.ts"] })).toBe(false);
    expect(sameTool(toolCall("Bash", input), toolCall("Bash", input, output))).toBe(false);
    // Outputs are the events' own, so another output is another result, whatever it holds.
    expect(sameTool(call, { ...call, output: [{ type: "text", text: "total 0" }] })).toBe(false);
  });
});

describe("summarizeTools", () => {
  it("counts what the calls did by kind, and files once however often they were touched", () => {
    expect(
      summarizeTools([
        toolCall("Read", { file_path: "a.ts" }),
        toolCall("Read", { file_path: "a.ts" }),
        toolCall("Grep", { pattern: "x" }),
        toolCall("Bash", { command: "ls" }),
        toolCall("Bash", { command: "pwd" }),
      ]),
    ).toBe("1 file read, 1 search, 2 commands run");
  });

  it("counts calls of tools without a kind as tool calls, not as tools", () => {
    expect(summarizeTools([toolCall("mcp__a__b", {}), toolCall("mcp__a__b", {})])).toBe("2 tool calls");
    expect(summarizeTools([toolCall("Read", { file_path: "a" }), toolCall("sleep", {})])).toBe(
      "1 file read, 1 other tool call",
    );
  });
});

describe("outputText", () => {
  it("reads the text of content items and leaves images to the thumbnails", () => {
    expect(
      outputText([
        { type: "text", text: "Opened the page" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      ]),
    ).toBe("Opened the page");
    expect(outputText({ content: [{ type: "text", text: "ok" }], isError: false })).toBe("ok");
  });

  it("lays JSON text out for reading", () => {
    expect(outputText('{"results":[{"step":1}]}')).toBe(JSON.stringify({ results: [{ step: 1 }] }, null, 2));
    expect(outputText("not { json")).toBe("not { json");
    // Laid out, an id past what a double holds would change; it stays as written.
    expect(outputText('{"id":1840000000000000001}')).toBe('{"id":1840000000000000001}');
  });

  it("reads Codex's, Cursor's and Muse's command results like Claude Code's", () => {
    expect(
      outputText(
        JSON.stringify({
          command: "grep -rn x",
          exit_code: 1,
          terminal_status: "failed",
          output: "grep : The term 'grep' is not recognized\r\n",
        }),
      ),
    ).toBe("Exit code 1\ngrep : The term 'grep' is not recognized");
    expect(outputText({ output: "npm test\nFAIL a.test.ts\n", exitCode: 1 })).toBe(
      "Exit code 1\nnpm test\nFAIL a.test.ts",
    );
    expect(outputText({ output: "ok\n", exitCode: 0 })).toBe("ok");
    expect(
      outputText({ exitCode: 2, signal: "", stdout: "built", stderr: "error: boom", executionTime: 3 }),
    ).toBe("Exit code 2\nbuilt\nerror: boom");
  });
});

describe("failureLine", () => {
  it("gives the exit code and the line of output that names the problem", () => {
    expect(
      failureLine(
        "Exit code 2\napps/ui/src/a.tsx(225,41): error TS2304: Cannot find name 'insetPx'.\n\nFound 1 error.",
      ),
    ).toBe("Exit 2 · apps/ui/src/a.tsx(225,41): error TS2304: Cannot find name 'insetPx'.");
  });

  it("falls back to the last line, and to the exit code alone", () => {
    expect(failureLine("Exit code 1\nnothing matched\nbye")).toBe("Exit 1 · bye");
    expect(failureLine("Exit code 137")).toBe("Exit 137");
  });

  it("reads the reason out of a JSON result and out of a tool's error wrapper", () => {
    expect(failureLine('{"error":"No browser is listening on port 9222."}')).toBe(
      "No browser is listening on port 9222.",
    );
    expect(failureLine("<tool_use_error>File does not exist.</tool_use_error>")).toBe("File does not exist.");
    expect(failureLine([{ type: "text", text: "Permission denied" }])).toBe("Permission denied");
  });

  it("reads Codex's and Cursor's failed commands", () => {
    expect(failureLine({ output: "> vitest\n a.test.ts\n 1 failed\n", exitCode: 1 })).toBe(
      "Exit 1 · 1 failed",
    );
    // A result with no reason in it says what it can, not the closing brace of its JSON.
    expect(failureLine({ status: "failed" })).toBe('"status": "failed"');
    expect(failureLine({ exitCode: 1, signal: "", stdout: "", stderr: "boom", executionTime: 3 })).toBe(
      "Exit 1 · boom",
    );
    expect(
      failureLine(
        JSON.stringify({ exit_code: 1, terminal_status: "failed", output: "grep : not recognized" }),
      ),
    ).toBe("Exit 1 · grep : not recognized");
  });
});

describe("exit codes", () => {
  it("reads the code off the first line and takes the line away", () => {
    expect(exitCodeOf("Exit code 2\nboom")).toBe(2);
    expect(withoutExitLine("Exit code 2\nboom")).toBe("boom");
    expect(exitCodeOf("boom")).toBeUndefined();
    expect(withoutExitLine("boom")).toBe("boom");
  });
});

describe("toolInputView", () => {
  it("shows a command as written, and a file edit as a diff", () => {
    expect(toolInputView(toolCall("Bash", { command: "bun test", description: "Test" }))).toEqual({
      kind: "code",
      label: "Command",
      text: "bun test",
    });
    expect(toolInputView(toolCall("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }))).toEqual({
      kind: "diff",
      edits: [{ before: "a", after: "b" }],
    });
  });

  it("names the one thing a file, search or fetch call is about", () => {
    expect(toolInputView(toolCall("Read", { file_path: "/w/a.ts", offset: 10, limit: 20 }))).toEqual({
      kind: "subject",
      text: "/w/a.ts · lines 11–30",
    });
    expect(toolInputView(toolCall("Grep", { pattern: "TODO", path: "src" }))).toEqual({
      kind: "subject",
      text: "TODO in src",
    });
    expect(toolInputView(toolCall("WebFetch", { url: "https://example.com" }))).toEqual({
      kind: "subject",
      text: "https://example.com",
    });
  });

  it("falls back to the input as JSON for other tools, and shows nothing for no input", () => {
    expect(toolInputView(toolCall("mcp__a__b", { role: "x" }))).toEqual({
      kind: "code",
      label: "Input",
      text: JSON.stringify({ role: "x" }, null, 2),
    });
    expect(toolInputView(toolCall("sleep", {}))).toBeUndefined();
    expect(toolInputView(toolCall("sleep", undefined))).toBeUndefined();
  });
});
