import type { PastSession } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_PICKS,
  defaultPicks,
  groupByProject,
  groupPicked,
  sessionKey,
  toggleGroup,
  toggleSession,
} from "../src/features/imports/model.ts";

const DAY = 86_400_000;
const now = 1_800_000_000_000;

const session = (
  id: string,
  daysAgo: number,
  cwd?: string,
  provider: PastSession["provider"] = "claude",
): PastSession =>
  ({
    provider,
    id,
    title: id,
    updatedAt: (now - daysAgo * DAY) as PastSession["updatedAt"],
    ...(cwd === undefined ? {} : { cwd }),
  }) as PastSession;

describe("groupByProject", () => {
  it("groups by folder, the most recent first, with chats last", () => {
    const groups = groupByProject(
      [
        session("a", 20, "C:\\code\\api"),
        session("chat", 0),
        session("b", 1, "C:\\code\\web", "codex"),
        session("c", 3, "c:/Code/API/", "opencode"),
      ],
      now,
    );
    expect(groups.map((group) => group.name)).toEqual(["web", "API", "Chats"]);
    const api = groups[1]!;
    expect(api.sessions.map((each) => each.id)).toEqual(["c", "a"]);
    expect(api.recent).toBe(1);
    expect(api.providers).toEqual(["opencode", "claude"]);
    expect(groups[2]!.cwd).toBeUndefined();
  });
});

describe("picks", () => {
  it("ticks the recent sessions, newest first, up to the cap", () => {
    const sessions = [
      ...Array.from({ length: DEFAULT_PICKS + 5 }, (_, index) => session(`r${index}`, index / 10, "/p")),
      session("old", 30, "/p"),
    ];
    const picked = defaultPicks(sessions, now);
    expect(picked.size).toBe(DEFAULT_PICKS);
    expect(picked.has(sessionKey(sessions[0]!))).toBe(true);
    expect(picked.has("claude:old")).toBe(false);
    expect(picked.has(`claude:r${DEFAULT_PICKS}`)).toBe(false);
  });

  it("toggles a whole group, or a session in it", () => {
    const [group] = groupByProject([session("a", 1, "/p"), session("b", 2, "/p")], now);
    let picked: ReadonlySet<string> = new Set();
    expect(groupPicked(group!, picked)).toBe("none");
    picked = toggleSession(group!.sessions[0]!, picked);
    expect(groupPicked(group!, picked)).toBe("some");
    picked = toggleGroup(group!, picked);
    expect(groupPicked(group!, picked)).toBe("all");
    picked = toggleGroup(group!, picked);
    expect(picked.size).toBe(0);
  });
});
