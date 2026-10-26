import { describe, expect, it } from "@effect/vitest";

import { toPastHistory, toPastSession } from "../src/sessions.ts";

type Session = Parameters<typeof toPastSession>[0];
type Messages = Parameters<typeof toPastHistory>[0];

const session = (overrides: Partial<Session>): Session =>
  ({
    id: "ses_1",
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 100, updated: 200 },
    title: "Fix the build",
    location: { directory: String.raw`C:\work` },
    model: { id: "glm", providerID: "opencode" },
    ...overrides,
  }) as Session;

describe("OpenCode past sessions", () => {
  it("lists the user's sessions with their folder and model", () => {
    expect(toPastSession(session({}))).toEqual({
      id: "ses_1",
      cwd: String.raw`C:\work`,
      title: "Fix the build",
      createdAt: 100,
      updatedAt: 200,
      model: "opencode/glm",
    });
  });

  it("leaves out subagents', archived and Cerium's sessions", () => {
    expect(toPastSession(session({ parentID: "ses_0" }))).toBeUndefined();
    expect(toPastSession(session({ time: { created: 1, updated: 2, archived: 3 } }))).toBeUndefined();
    expect(toPastSession(session({ metadata: { createdBy: "cerium" } }))).toBeUndefined();
  });

  it("turns each user message and the assistant messages after it into a turn", () => {
    const history = toPastHistory([
      { id: "u1", type: "user", text: "run the tests", time: { created: 5 } },
      {
        id: "a1",
        type: "assistant",
        agent: "build",
        model: { id: "glm", providerID: "opencode" },
        time: { created: 6 },
        content: [
          { type: "reasoning", text: "Running them." },
          {
            type: "tool",
            id: "c1",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "npm test" },
              content: [{ type: "text", text: "ok" }],
              metadata: { exit: 0 },
            },
            time: { created: 6 },
          },
          {
            type: "tool",
            id: "c2",
            name: "read",
            state: { status: "streaming", input: "{" },
            time: { created: 7 },
          },
          { type: "text", text: "All pass." },
        ],
      },
    ] as unknown as Messages);
    expect(history.model).toBe("opencode/glm");
    expect(history.turns[0]?.prompt).toBe("run the tests");
    expect(history.turns[0]?.events.map((event) => event.payload)).toEqual([
      { _tag: "ReasoningCompleted", messageId: "a1:reasoning:0", text: "Running them." },
      { _tag: "ToolCallStarted", callId: "c1", toolName: "shell", input: { command: "npm test" } },
      { _tag: "ToolCallCompleted", callId: "c1", output: { output: "ok", exitCode: 0 }, isError: false },
      { _tag: "ToolCallStarted", callId: "c2", toolName: "read", input: {} },
      {
        _tag: "ToolCallCompleted",
        callId: "c2",
        output: "The turn ended before this tool call finished.",
        isError: true,
      },
      { _tag: "MessageCompleted", messageId: "a1:3", text: "All pass." },
    ]);
  });
});
