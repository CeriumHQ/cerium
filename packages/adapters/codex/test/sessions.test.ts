import { describe, expect, it } from "@effect/vitest";

import type { Thread } from "../src/protocol/v2/Thread.ts";
import type { Turn } from "../src/protocol/v2/Turn.ts";
import { toPastHistory, toPastSession } from "../src/sessions.ts";

const thread = (overrides: Partial<Thread>): Thread =>
  ({
    id: "th",
    preview: "fix the build",
    name: null,
    ephemeral: false,
    parentThreadId: null,
    originator: "codex_cli_rs",
    cwd: String.raw`C:\work`,
    createdAt: 100,
    updatedAt: 200,
    recencyAt: null,
    model: "gpt-x",
    ...overrides,
  }) as Thread;

const turn = (id: string, items: Turn["items"], overrides: Partial<Turn> = {}): Turn => ({
  id,
  rootTurnId: null,
  items,
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: 150,
  completedAt: 160,
  durationMs: 10_000,
  ...overrides,
});

describe("Codex past sessions", () => {
  it("lists the user's own threads, named or by their first message", () => {
    expect(toPastSession(thread({}))).toEqual({
      id: "th",
      cwd: String.raw`C:\work`,
      title: "fix the build",
      createdAt: 100_000,
      updatedAt: 200_000,
      model: "gpt-x",
    });
    expect(toPastSession(thread({ name: "Build fix" }))?.title).toBe("Build fix");
  });

  it("leaves out Cerium's threads, subagents' and ephemeral ones", () => {
    expect(toPastSession(thread({ originator: "cerium" }))).toBeUndefined();
    expect(toPastSession(thread({ parentThreadId: "parent" }))).toBeUndefined();
    expect(toPastSession(thread({ ephemeral: true }))).toBeUndefined();
  });

  it("reads each turn's user message as its prompt and translates the rest", () => {
    const history = toPastHistory("th", [
      turn("t1", [
        {
          type: "userMessage",
          id: "u1",
          clientId: null,
          content: [
            { type: "text", text: "fix it", text_elements: [] },
            { type: "localImage", path: "a.png" },
          ],
        },
        { type: "agentMessage", id: "m1", text: "Done.", phase: null } as Turn["items"][number],
      ]),
      turn("t2", [], { rootTurnId: "t1" }),
      turn("t3", [], { status: "interrupted", startedAt: null }),
    ]);
    expect(history.turns).toEqual([
      {
        prompt: "fix it\n\n(image)",
        at: 150_000,
        events: [
          expect.objectContaining({ payload: { _tag: "MessageCompleted", messageId: "m1", text: "Done." } }),
          { payload: { _tag: "TurnCompleted", stopReason: "completed" } },
        ],
      },
      // A turn Codex started on behalf of another isn't the user's.
      { prompt: "", events: [{ payload: { _tag: "TurnCompleted", stopReason: "interrupted" } }] },
    ]);
  });
});
