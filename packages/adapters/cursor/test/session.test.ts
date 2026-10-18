import { JsonlLocalAgentStore } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";

import { NATIVE_SUBAGENT_TOOLS } from "../src/manifest.ts";
import {
  READ_ONLY_TOOLS,
  accessOptions,
  localStoreFor,
  toolRestrictions,
  withInstructions,
} from "../src/session.ts";

describe("access modes", () => {
  it("runs readOnly and ask with read-only tools, since Cursor cannot ask", () => {
    for (const access of ["readOnly", "ask"] as const) {
      const { tools, disallowedTools } = toolRestrictions(access);
      expect(tools).toEqual(READ_ONLY_TOOLS);
      for (const writer of ["edit", "delete", "shell", "write", "applyAgentDiff", "piBash", "piWrite"]) {
        expect(tools).not.toContain(writer);
      }
      expect(disallowedTools).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    }
  });

  it("lets acceptEdits edit but withholds commands", () => {
    const { tools, disallowedTools } = toolRestrictions("acceptEdits");
    expect(tools).toBeUndefined();
    expect(disallowedTools).toEqual([...NATIVE_SUBAGENT_TOOLS, "shell", "piBash"]);
  });

  it("gives auto every tool, reviewed by Cursor's Auto-review in the user's sandbox", () => {
    expect(toolRestrictions("auto")).toEqual({ disallowedTools: [...NATIVE_SUBAGENT_TOOLS] });
    expect(accessOptions("auto")).toEqual({ autoReview: true });
  });

  it("gives fullAccess every tool, outside the sandbox", () => {
    expect(toolRestrictions("fullAccess")).toEqual({ disallowedTools: [...NATIVE_SUBAGENT_TOOLS] });
    expect(accessOptions("fullAccess")).toEqual({ sandboxOptions: { enabled: false } });
    for (const access of ["readOnly", "ask", "acceptEdits"] as const) {
      expect(accessOptions(access)).toEqual({});
    }
  });

  it("disables native subagents in every mode", () => {
    for (const access of ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"] as const) {
      expect(toolRestrictions(access).disallowedTools).toContain("task");
    }
  });
});

describe("where agents are kept", () => {
  it("leaves the SDK's own store alone where its files fit Windows' path limit", () => {
    expect(localStoreFor("C:\\Users\\Ada\\code\\app", "win32")).toEqual({});
  });

  it("keeps a long Windows workspace's agents in JSONL files beside the default store", () => {
    const deep = `C:\\Users\\Ada\\AppData\\Local\\Temp\\${"nested-folder\\".repeat(4)}workspace`;
    const { store } = localStoreFor(deep, "win32");
    expect(store).toBeInstanceOf(JsonlLocalAgentStore);
  });

  it("never switches stores off Windows", () => {
    expect(localStoreFor(`/home/ada/${"nested-folder/".repeat(20)}workspace`, "linux")).toEqual({});
  });
});

describe("Cerium's instructions", () => {
  it("open the first turn, marked as Cerium's", () => {
    const prompt = withInstructions("Use the bus to spawn.", "Fix the bug.");
    expect(prompt.startsWith("<cerium_instructions>\n")).toBe(true);
    expect(prompt).toContain("\nUse the bus to spawn.\n</cerium_instructions>\n\nFix the bug.");
  });
});
