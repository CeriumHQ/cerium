import { describe, expect, it, vi } from "vite-plus/test";

import {
  agentFixPrompt,
  appendAgentText,
  OUTPUT_TAIL_CHARS,
  terminalSnippet,
} from "../src/features/composer/agentFix.ts";
import { appendSegments, draftText, withComments, type Segment } from "../src/features/composer/draft.ts";

describe("terminal snippets", () => {
  it("removes terminal escape sequences and blank edges while keeping indentation", () => {
    const raw =
      "\r\n \t\r\n\x1b[?25l\x1b[31m  error\x1b[0m\r\n\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07\r\n\x1bPignored\x1b\\\t \r\n";
    expect(terminalSnippet(raw)).toBe("```\n  error\nlink\n```");
    expect(terminalSnippet("\x1b[0m \r\n\t\x07")).toBe("");
  });

  it("chooses a fence that the selection cannot close", () => {
    expect(terminalSnippet("```\noutput\n```")).toBe("~~~\n```\noutput\n```\n~~~");
    expect(terminalSnippet("```\n~~~")).toBe("````\n```\n~~~\n````");
  });

  it("keeps a bounded tail without splitting a surrogate pair", () => {
    const marker = "[Earlier output omitted]\n";
    const end = "x".repeat(OUTPUT_TAIL_CHARS - marker.length - 1);
    const snippet = terminalSnippet(`${"earlier output\n".repeat(10)}😀${end}`);
    expect(snippet).toBe(`\`\`\`\n${marker}${end}\n\`\`\``);
  });

  it("appends editable prompt text which survives the composer's send formatting", () => {
    let segments: ReadonlyArray<Segment> = [{ kind: "text", text: "What happened?" }];
    const append = vi.fn<Parameters<typeof appendAgentText>[0]["append"]>(({ segments: added }) => {
      segments = appendSegments(segments, added);
    });
    const snippet = terminalSnippet("error\n  details");
    appendAgentText({ append }, snippet);
    expect(append).toHaveBeenCalledWith({ segments: [{ kind: "text", text: snippet }] });
    expect(withComments(draftText(segments), [])).toBe("What happened?\n```\nerror\n  details\n```");
  });
});

describe("agent fix prompts", () => {
  it("labels a failed terminal command and its exit code", () => {
    expect(
      agentFixPrompt({
        command: "bun run check",
        context: "Test in /work",
        exitCode: 2,
        output: "\nfailed\n",
      }),
    ).toBe(
      "Please investigate and fix this failure.\n\nCommand: bun run check\nContext: Test in /work\nExit code: 2\n\nOutput tail:\n```\nfailed\n```",
    );
  });

  it("includes the git hook failure and sanitized output without inventing an exit code", () => {
    expect(
      agentFixPrompt({
        command: "git commit --amend",
        context: "/work",
        message: "The pre-commit hook stopped the commit.",
        output: "\n\x9b31mLint failed\x9b0m\n\n",
      }),
    ).toBe(
      "Please investigate and fix this failure.\n\nCommand: git commit --amend\nContext: /work\nFailure: The pre-commit hook stopped the commit.\n\nOutput tail:\n```\nLint failed\n```",
    );
  });

  it("keeps useful context when there was no output", () => {
    expect(agentFixPrompt({ context: "Run in /work", exitCode: 1, output: " \r\n" })).toBe(
      "Please investigate and fix this failure.\n\nContext: Run in /work\nExit code: 1",
    );
  });
});
