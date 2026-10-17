import { describe, expect, it } from "@effect/vitest";

import { NATIVE_SUBAGENT_TOOLS } from "../src/manifest.ts";
import { READ_ONLY_TOOLS, toolRestrictions, withInstructions } from "../src/session.ts";

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

  it("disables native subagents in every mode", () => {
    for (const access of ["readOnly", "ask", "acceptEdits"] as const) {
      expect(toolRestrictions(access).disallowedTools).toContain("task");
    }
  });
});

describe("Cerium's instructions", () => {
  it("open the first turn, marked as Cerium's", () => {
    const prompt = withInstructions("Use the bus to spawn.", "Fix the bug.");
    expect(prompt.startsWith("<cerium_instructions>\n")).toBe(true);
    expect(prompt).toContain("\nUse the bus to spawn.\n</cerium_instructions>\n\nFix the bug.");
  });
});
