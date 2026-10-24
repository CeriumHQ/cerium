import type { HarnessStatus } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { DEMO_RUNS, demoAt, demoTimes, leadStatus } from "../src/features/onboarding/demo.ts";
import {
  CHAPTERS,
  chapterFromQuery,
  harnessReadiness,
  opensOnLaunch,
  readinessSummary,
  stepChapter,
  welcomeKey,
} from "../src/features/onboarding/model.ts";

describe("opensOnLaunch", () => {
  it("opens on a desktop's first run, with no threads yet", () => {
    expect(opensOnLaunch({ web: false, welcomed: undefined, threads: 0 })).toBe(true);
  });

  it("stays shut once finished, on a computer with threads, before the threads answer, and on the web", () => {
    expect(opensOnLaunch({ web: false, welcomed: "done", threads: 0 })).toBe(false);
    expect(opensOnLaunch({ web: false, welcomed: undefined, threads: 3 })).toBe(false);
    expect(opensOnLaunch({ web: false, welcomed: undefined, threads: undefined })).toBe(false);
    expect(opensOnLaunch({ web: true, welcomed: undefined, threads: 0 })).toBe(false);
  });
});

describe("stepChapter", () => {
  it("steps through the chapters and holds at either end", () => {
    expect(stepChapter(0, 1)).toBe(1);
    expect(stepChapter(0, -1)).toBe(0);
    expect(stepChapter(CHAPTERS.length - 1, 1)).toBe(CHAPTERS.length - 1);
  });
});

describe("chapterFromQuery", () => {
  it("names a chapter, or the first for a bare flag, and nothing without one", () => {
    expect(chapterFromQuery("?welcome=agents")).toBe(
      CHAPTERS.findIndex((chapter) => chapter.id === "agents"),
    );
    expect(chapterFromQuery("?welcome")).toBe(0);
    expect(chapterFromQuery("?welcome=nope")).toBe(0);
    expect(chapterFromQuery("?other=1")).toBeUndefined();
  });
});

describe("welcomeKey", () => {
  const press = (key: string, more: Partial<Parameters<typeof welcomeKey>[0]> = {}) =>
    welcomeKey({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      inField: false,
      inGroup: false,
      onButton: false,
      ...more,
    });

  it("moves on with Enter and the arrows, back with the left arrow, and skips with Escape", () => {
    expect(press("Enter")).toBe("next");
    expect(press("ArrowRight")).toBe("next");
    expect(press("ArrowLeft")).toBe("back");
    expect(press("Escape")).toBe("skip");
    expect(press("a")).toBeUndefined();
  });

  it("leaves Enter to a button, the arrows to a group, every key to a field, and shortcuts alone", () => {
    expect(press("Enter", { onButton: true })).toBeUndefined();
    expect(press("ArrowRight", { onButton: true })).toBe("next");
    expect(press("ArrowRight", { inGroup: true })).toBeUndefined();
    expect(press("Escape", { inGroup: true })).toBe("skip");
    expect(press("PageDown", { inGroup: true })).toBe("next");
    expect(press("Enter", { inGroup: true })).toBe("next");
    expect(press("Escape", { inField: true })).toBeUndefined();
    expect(press("ArrowRight", { ctrlKey: true })).toBeUndefined();
  });
});

describe("harnessReadiness", () => {
  const installed = (auth: Extract<HarnessStatus, { _tag: "HarnessInstalled" }>["auth"]): HarnessStatus => ({
    _tag: "HarnessInstalled",
    provider: "claude",
    executablePath: "/usr/bin/claude",
    version: "2.1.0",
    auth,
  });

  it("is ready signed in, needs the user signed out or before setup, and is missing uninstalled", () => {
    expect(harnessReadiness(installed({ _tag: "LoggedIn", method: "claude.ai" }))).toBe("ready");
    expect(harnessReadiness(installed({ _tag: "LoggedOut" }))).toBe("attention");
    expect(
      harnessReadiness({
        ...installed({ _tag: "LoggedIn" }),
        setup: {
          name: "sandbox",
          reason: "missing",
          command: "muse setup",
          elevated: true,
          blocks: ["auto"],
        },
      } as HarnessStatus),
    ).toBe("attention");
    expect(
      harnessReadiness({ _tag: "HarnessMissing", provider: "codex", installHint: "npm i -g codex" }),
    ).toBe("missing");
    expect(harnessReadiness(undefined)).toBe("unknown");
  });
});

describe("readinessSummary", () => {
  it("counts what's ready, what needs the user and what's missing", () => {
    expect(readinessSummary(["ready", "attention", "missing", "missing", "ready"])).toBe(
      "2 ready · 1 to set up · 2 not installed",
    );
    expect(readinessSummary(["ready", "ready"])).toBe("2 ready");
  });

  it("says when nothing is known yet, and when nothing is installed", () => {
    expect(readinessSummary(["unknown", "unknown"])).toBe("Looking for your harnesses…");
    expect(readinessSummary(["missing", "missing"])).toBe("None installed yet");
  });
});

describe("the welcome's sample run", () => {
  const run = DEMO_RUNS[0]!;

  it("types the message, sends it, hands it out, and answers once every agent is done", () => {
    const times = demoTimes(run);
    expect(demoAt(run, 0)).toMatchObject({ typed: 0, sent: false, lead: "idle", answered: false });
    expect(demoAt(run, times.sent - 1).typed).toBe(run.prompt.length);
    expect(demoAt(run, times.sent)).toMatchObject({ sent: true, lead: "reading" });
    const working = demoAt(run, times.agents[0]!.starts);
    expect(working.lead).toBe("delegating");
    expect(working.agents[0]?.phase).toBe("working");
    expect(working.agents.at(-1)?.phase).toBe("waiting");
    const allDone = demoAt(run, Math.max(...times.agents.map((agent) => agent.ends)));
    expect(allDone.agents.every((agent) => agent.phase === "done")).toBe(true);
    expect(allDone.lead).toBe("answering");
    expect(demoAt(run, times.answered)).toMatchObject({ lead: "done", answered: true, finished: true });
  });

  it("says what the lead is doing", () => {
    const times = demoTimes(run);
    expect(leadStatus(demoAt(run, 0))).toBe("Waiting for you");
    expect(leadStatus(demoAt(run, times.agents[0]!.starts))).toBe("Handing off 3 parts");
    expect(leadStatus(demoAt(run, times.agents.at(-1)!.starts))).toBe("Waiting on 3 agents");
    expect(leadStatus(demoAt(run, times.answered))).toBe("Done");
  });

  it("lists each run's agents in the harnesses' order, so no two beams cross", () => {
    const order = ["claude", "codex", "muse", "cursor", "opencode"];
    for (const each of DEMO_RUNS) {
      const indices = each.agents.map((agent) => order.indexOf(agent.provider));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });
});
