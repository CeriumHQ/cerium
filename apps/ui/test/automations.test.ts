import type { ModelInfo } from "@cerium/protocol";
import type { Automation, AutomationRun } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  draftOf,
  edited,
  inputOf,
  newDraft,
  pastLabel,
  runState,
  soonLabel,
  whenLabel,
} from "../src/features/automations/model.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";

const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

const opus = {
  provider: "claude",
  id: "opus",
  label: "Opus",
  efforts: ["low", "medium", "high"],
} as unknown as ModelInfo;

const automation: Automation = {
  id: "a1",
  name: "Morning triage",
  prompt: "Look at the open issues.",
  project: "C:/code/app",
  worktree: true,
  lead: { provider: "claude", model: "opus", effort: "high", access: "auto" },
  when: { _tag: "Weekdays", at: 9 * 60 + 30 },
  paused: false,
  createdAt: 1,
  updatedAt: 1,
};

describe("whenLabel", () => {
  it("says when it goes off in a few words", () => {
    expect(whenLabel({ _tag: "Hourly", minute: 0 })).toBe("Every hour");
    expect(whenLabel({ _tag: "Hourly", minute: 5 })).toBe("Every hour at :05");
    expect(whenLabel({ _tag: "Weekdays", at: 570 })).toMatch(/^Weekdays at 9:30/);
    expect(whenLabel({ _tag: "CiFailed" })).toBe("When CI fails");
  });
});

describe("soonLabel and pastLabel", () => {
  it("name a time by its day", () => {
    const now = at(26, 10);
    expect(soonLabel(at(26, 10, 12), now)).toBe("in 12 min");
    expect(soonLabel(at(26, 15), now)).toMatch(/^Today 3:00/);
    expect(soonLabel(at(27, 9), now)).toMatch(/^Tomorrow 9:00/);
    expect(pastLabel(at(25, 9), now)).toMatch(/^Yesterday 9:00/);
  });
});

describe("the form", () => {
  it("turns a saved automation into its form and back", () => {
    const result = inputOf(draftOf(automation), opus);
    expect(result).toEqual({
      input: {
        name: automation.name,
        prompt: automation.prompt,
        project: automation.project,
        worktree: true,
        lead: automation.lead,
        when: automation.when,
      },
    });
    expect(edited(draftOf(automation), automation)).toBe(false);
    expect(edited({ ...draftOf(automation), name: "Evening" }, automation)).toBe(true);
  });

  it("says what a new one still lacks", () => {
    const draft = newDraft({ project: undefined, model: "claude/opus", effort: undefined, access: "auto" });
    expect(inputOf(draft, opus)).toEqual({ missing: "Name it" });
    expect(inputOf({ ...draft, name: "Nightly", prompt: "Check" }, opus)).toEqual({
      missing: "Pick a project",
    });
    expect(inputOf({ ...draft, name: "Nightly", prompt: "Check", project: "C:/app" }, undefined)).toEqual({
      missing: "Pick a model",
    });
  });

  it("drops an effort the model doesn't offer", () => {
    const result = inputOf({ ...draftOf(automation), effort: "max" }, opus);
    expect("input" in result && result.input.lead.effort).toBeUndefined();
  });
});

describe("runState", () => {
  const run: AutomationRun = { id: "r1", at: 1, cause: "schedule", threadId: "thr_1" as never };
  const thread = (status: ThreadSummary["status"]) => ({ status }) as ThreadSummary;

  it("follows the thread a run started", () => {
    expect(runState(run, thread("running"))).toBe("working");
    expect(runState(run, thread("awaitingApproval"))).toBe("needsYou");
    expect(runState(run, thread("idle"))).toBe("done");
    expect(runState(run, thread("failed"))).toBe("failed");
  });

  it("says when a run started nothing", () => {
    expect(runState({ id: "r2", at: 1, cause: "missed", skipped: "Nearer next" }, undefined)).toBe("skipped");
    expect(runState({ id: "r3", at: 1, cause: "manual", failed: "Gone" }, undefined)).toBe("notStarted");
  });
});
