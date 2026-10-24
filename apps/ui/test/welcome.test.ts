import type { HarnessStatus } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  harnessReadiness,
  needsHarness,
  opensOnLaunch,
  stepFromQuery,
  stepsFor,
  welcomeKey,
} from "../src/features/onboarding/model.ts";

const installed = (auth: Extract<HarnessStatus, { _tag: "HarnessInstalled" }>["auth"]): HarnessStatus => ({
  _tag: "HarnessInstalled",
  provider: "claude",
  executablePath: "/usr/bin/claude",
  version: "2.1.0",
  auth,
});
const missing: HarnessStatus = { _tag: "HarnessMissing", provider: "codex", installHint: "npm i -g codex" };

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

describe("stepsFor", () => {
  it("says hello and offers the glass, and asks for a harness only when one is needed", () => {
    expect(stepsFor(false)).toEqual(["hello", "glass"]);
    expect(stepsFor(true)).toEqual(["hello", "glass", "connect"]);
  });
});

describe("stepFromQuery", () => {
  it("names a step, or the first for a bare flag or an unknown one, and nothing without one", () => {
    expect(stepFromQuery("?welcome=glass")).toBe("glass");
    expect(stepFromQuery("?welcome")).toBe("hello");
    expect(stepFromQuery("?welcome=nope")).toBe("hello");
    expect(stepFromQuery("?other=1")).toBeUndefined();
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
    expect(harnessReadiness(missing)).toBe("missing");
    expect(harnessReadiness(undefined)).toBe("unknown");
  });
});

describe("needsHarness", () => {
  it("asks for a harness once they're known and none can run, and not before", () => {
    expect(needsHarness(undefined)).toBe(false);
    expect(needsHarness([missing, installed({ _tag: "LoggedOut" })])).toBe(true);
    expect(needsHarness([missing, installed({ _tag: "LoggedIn" })])).toBe(false);
    expect(needsHarness([])).toBe(true);
  });
});
