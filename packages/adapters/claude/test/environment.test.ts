import { describe, expect, it } from "@effect/vitest";

import { completionOptions } from "../src/complete.ts";
import { claudeEnvironment } from "../src/environment.ts";
import { TODO_TOOLS_ENV } from "../src/manifest.ts";
import { inspectOptions } from "../src/models.ts";
import { toSdkOptions } from "../src/session.ts";
import { sideQuestionOptions } from "../src/sideQuestion.ts";

describe("Claude process attribution", () => {
  it("replaces inherited entrypoints without changing the parent environment", () => {
    for (const entrypoint of [undefined, "sdk-cli", "sdk-ts", "cli", "custom-client"]) {
      const inherited = Object.freeze({
        PATH: "/bin",
        CLAUDE_CONFIG_DIR: "/claude-config",
        CLAUDE_CODE_ENTRYPOINT: entrypoint,
      });
      expect(claudeEnvironment(inherited)).toEqual({
        ...inherited,
        CLAUDE_CODE_ENTRYPOINT: "cerium",
      });
      expect(inherited.CLAUDE_CODE_ENTRYPOINT).toBe(entrypoint);
    }
  });

  it("identifies every SDK launch as Cerium while retaining its environment flags", () => {
    const request = { cwd: ".", model: "opus", instructions: "Answer briefly.", prompt: "Why?" };
    const controller = new AbortController();
    const session = toSdkOptions(
      "claude",
      { cwd: ".", model: "opus", access: "ask", mcpServers: {}, includeUserMcpServers: false },
      async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
    );
    const completion = completionOptions("claude", request, controller);
    const sideQuestion = sideQuestionOptions("claude", { ...request, sessionId: "session-1" }, controller);

    for (const options of [
      session,
      completion,
      sideQuestion,
      inspectOptions("claude", undefined),
      inspectOptions("claude", "/work"),
    ]) {
      expect(options.env?.["CLAUDE_CODE_ENTRYPOINT"]).toBe("cerium");
    }
    expect(session.env).toMatchObject(TODO_TOOLS_ENV);
    expect(completion.env?.["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
    expect(sideQuestion.env?.["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
  });
});
