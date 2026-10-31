import { assert, describe, it } from "@effect/vitest";

import { sideQuestionOptions } from "../src/sideQuestion.ts";

describe("sideQuestionOptions", () => {
  const options = sideQuestionOptions(
    "claude",
    {
      model: "opus",
      cwd: "C:/work",
      sessionId: "session-1",
      instructions: "Answer briefly.",
      prompt: "Why?",
    },
    new AbortController(),
  );

  it("answers in a fork of the session that is never saved", () => {
    assert.strictEqual(options.resume, "session-1");
    assert.isTrue(options.forkSession);
    assert.isFalse(options.persistSession);
  });

  it("can only read, and refuses rather than asks for anything else", () => {
    assert.deepStrictEqual(options.tools, ["Read", "Glob", "Grep"]);
    assert.deepStrictEqual(options.allowedTools, ["Read", "Glob", "Grep"]);
    assert.strictEqual(options.permissionMode, "dontAsk");
    assert.deepStrictEqual(options.mcpServers, {});
    assert.isTrue(options.strictMcpConfig);
  });
});
