import type { Item, Session } from "@muse-code/sdk/dist/src/msp.js";
import { describe, expect, it } from "@effect/vitest";

import { plainPath, toPastHistory, toPastSession } from "../src/sessions.ts";

const session = (overrides: Partial<Session>): Session => ({
  activeTurnId: null,
  createdAt: "2026-10-20T10:00:00Z",
  updatedAt: "2026-10-20T11:00:00Z",
  lastActivityAt: "2026-10-20T10:30:00Z",
  forkedFrom: null,
  modelId: "muse-spark",
  path: "C:/sessions/s.jsonl",
  providerId: "meta",
  sessionId: "s1",
  status: "notLoaded",
  title: "Fix the build",
  turnCount: 3,
  workspaceRoot: String.raw`\\?\C:\work`,
  ...overrides,
});

const item = (itemId: string, kind: Item["kind"], fields: Partial<Item> = {}): Item => ({
  itemId,
  kind,
  revision: 1,
  status: "completed",
  ...fields,
});

describe("Muse past sessions", () => {
  it("lists the user's sessions with a plain folder path", () => {
    expect(toPastSession(session({}))).toEqual({
      id: "s1",
      cwd: String.raw`C:\work`,
      title: "Fix the build",
      createdAt: Date.parse("2026-10-20T10:00:00Z"),
      updatedAt: Date.parse("2026-10-20T10:30:00Z"),
      turns: 3,
      model: "muse-spark",
    });
    expect(plainPath("C:/Users/me/work")).toBe(
      process.platform === "win32" ? String.raw`C:\Users\me\work` : "C:/Users/me/work",
    );
  });

  it("leaves out Cerium's sessions, subagents' and ephemeral ones", () => {
    expect(toPastSession(session({ createdByClient: { name: "cerium", version: "0" } }))).toBeUndefined();
    expect(toPastSession(session({ kind: "subagent" }))).toBeUndefined();
    expect(toPastSession(session({ path: "" }))).toBeUndefined();
  });

  it("starts a turn at each user message and translates the items after it", () => {
    const history = toPastHistory(
      [
        item("u1", "userMessage", { text: "raw", displayText: "fix it", recordedAt: "2026-10-20T10:05:00Z" }),
        item("m1", "agentMessage", { text: "Fixed." }),
        item("m2", "agentMessage", { text: "Gone.", retracted: true }),
      ],
      String.raw`C:\work`,
    );
    expect(history.turns).toEqual([
      {
        prompt: "fix it",
        at: Date.parse("2026-10-20T10:05:00Z"),
        events: [
          expect.objectContaining({ payload: { _tag: "MessageCompleted", messageId: "m1", text: "Fixed." } }),
        ],
      },
    ]);
  });
});
