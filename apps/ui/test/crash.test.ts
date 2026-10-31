import { describe, expect, it } from "@effect/vitest";

import {
  asBackendFailure,
  backendFailureDetails,
  renderErrorDetails,
  renderErrorMessage,
  shortMessage,
} from "../src/features/crash/model.ts";
import { uiCrashReport } from "../src/features/crash/report.ts";

describe("uiCrashReport", () => {
  it("carries the error's name, message and stack", () => {
    const error = new TypeError("x is undefined");
    expect(uiCrashReport("render", error, "pane")).toEqual({
      category: "render",
      kind: "pane",
      name: "TypeError",
      message: "x is undefined",
      stack: error.stack,
    });
    expect(uiCrashReport("uncaught", "plain")).toEqual({
      category: "uncaught",
      name: "Error",
      message: "plain",
    });
  });

  it("leaves out what browsers raise for nothing", () => {
    expect(
      uiCrashReport("uncaught", new Error("ResizeObserver loop completed with undelivered notifications.")),
    ).toBeUndefined();
    expect(uiCrashReport("uncaught", "Script error.")).toBeUndefined();
  });
});

describe("asBackendFailure", () => {
  it("reads the shell's failure, and nothing else", () => {
    expect(asBackendFailure({ kind: "crash", message: "boom", log: "x", at: 1 })).toEqual({
      kind: "crash",
      message: "boom",
      log: "x",
      at: 1,
    });
    expect(asBackendFailure({ kind: "crash", message: "boom", at: 1 })?.log).toBe("");
    expect(asBackendFailure({ kind: "melted", message: "boom", at: 1 })).toBeUndefined();
    expect(asBackendFailure(undefined)).toBeUndefined();
    expect(asBackendFailure(null)).toBeUndefined();
  });
});

describe("failure text", () => {
  it("keeps a message to its first line, cut short", () => {
    expect(shortMessage("first\nsecond")).toBe("first");
    expect(shortMessage("x".repeat(10), 5)).toBe("xxxx…");
  });

  it("puts the build, the failure and the log in a backend's details", () => {
    const details = backendFailureDetails(
      { kind: "databaseOpen", message: "Could not open: EBUSY", log: "line", at: 0 },
      "win32",
    );
    expect(details).toContain("Cerium dev on win32");
    expect(details).toContain("(databaseOpen, 1970-01-01T00:00:00.000Z)");
    expect(details).toContain("Could not open: EBUSY");
    expect(details).toContain("Backend log:\nline");
  });

  it("puts a view's stack and component stack in its details", () => {
    const error = new TypeError("x is undefined");
    const details = renderErrorDetails(error, "\n    at Transcript\n    at ThreadPane", undefined);
    expect(details).toContain("TypeError: x is undefined");
    expect(details).toContain("Component stack:\nat Transcript");
    expect(renderErrorMessage(error)).toBe("x is undefined");
    expect(renderErrorMessage("plain")).toBe("plain");
  });
});
