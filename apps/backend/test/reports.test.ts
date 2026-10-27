import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Logger } from "effect";

import { HarnessFailure, HarnessUnavailable } from "@cerium/harness";

import { crashReport, reportLogger, type CrashReportMessage } from "../src/reports.ts";

/** Runs `effect` with the report logger, and gives back what it posted. */
const posted = (effect: Effect.Effect<void>) => {
  const reports: Array<CrashReportMessage> = [];
  Effect.runSync(effect.pipe(Effect.provide(Logger.layer([reportLogger((report) => reports.push(report))]))));
  return reports;
};

describe("reportLogger", () => {
  it("posts logs annotated as reports, with their category, kind and context", () => {
    const failure = new HarnessFailure({
      provider: "codex",
      message: "app-server exited",
      cause: new Error("x"),
    });
    const reports = posted(
      Effect.logError("Harness session failed to start", Cause.fail(failure)).pipe(
        Effect.annotateLogs({ report: "harness", harness: "codex", phase: "start", project: "acme" }),
      ),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      _tag: "CrashReport",
      category: "harness",
      name: "HarnessFailure",
      message: "app-server exited",
      context: { harness: "codex", phase: "start" },
    });
    expect(reports[0]?.context).not.toHaveProperty("project");
  });

  it("reports a plain log in its own words", () => {
    const reports = posted(
      Effect.logWarning("The relay closed the connection with code 1011").pipe(
        Effect.annotateLogs({ report: "relay", kind: "close", code: 1011 }),
      ),
    );
    expect(reports).toEqual([
      expect.objectContaining({
        category: "relay",
        kind: "close",
        message: "The relay closed the connection with code 1011",
        context: { code: 1011 },
      }),
    ]);
  });

  it("ignores logs that aren't reports, the user's own harness state, and interruptions", () => {
    const unavailable = new HarnessUnavailable({ provider: "muse", reason: "loggedOut", message: "Sign in" });
    expect(
      posted(
        Effect.all([
          Effect.logError("just a log"),
          Effect.logError("not installed", Cause.fail(unavailable)).pipe(
            Effect.annotateLogs({ report: "harness" }),
          ),
          Effect.logError("stopped", Cause.interrupt()).pipe(Effect.annotateLogs({ report: "harness" })),
          Effect.logError("unknown category").pipe(Effect.annotateLogs({ report: "analytics" })),
        ]).pipe(Effect.asVoid),
      ),
    ).toEqual([]);
  });
});

describe("crashReport", () => {
  it("names a tagged error by its tag and keeps its stack", () => {
    const error = new Error("boom");
    expect(crashReport("crash", error, { kind: "uncaught" })).toMatchObject({
      _tag: "CrashReport",
      category: "crash",
      kind: "uncaught",
      name: "Error",
      message: "boom",
      stack: error.stack,
    });
  });
});
