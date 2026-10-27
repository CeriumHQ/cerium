import { describe, expect, it } from "@effect/vitest";

import { failureOnExit, isBackendFailed, outputTail } from "../src/backendFailure.ts";

describe("isBackendFailed", () => {
  it("takes the backend's own message and nothing else", () => {
    expect(isBackendFailed({ _tag: "BackendFailed", kind: "databaseMigrate", message: "x" })).toBe(true);
    expect(isBackendFailed({ _tag: "BackendFailed", kind: "exited", message: "x" })).toBe(false);
    expect(isBackendFailed({ _tag: "BackendFailed", kind: "crash" })).toBe(false);
    expect(isBackendFailed({ url: "ws://x", token: "t" })).toBe(false);
    expect(isBackendFailed("stop")).toBe(false);
  });
});

describe("outputTail", () => {
  it("keeps the latest output, from a whole line", () => {
    const tail = outputTail(20);
    tail.write("first line\nsecond line\n");
    tail.write(Buffer.from("third line\n"));
    expect(tail.read()).toBe("third line");
  });

  it("keeps everything while it fits", () => {
    const tail = outputTail(100);
    tail.write("one\ntwo\n");
    expect(tail.read()).toBe("one\ntwo");
  });
});

describe("failureOnExit", () => {
  it("prefers what the backend said, else names the exit code", () => {
    expect(failureOnExit({ kind: "listen", message: "EACCES" }, 1, "log", 5)).toEqual({
      kind: "listen",
      message: "EACCES",
      log: "log",
      at: 5,
    });
    expect(failureOnExit(undefined, 3221225477, "", 5)).toEqual({
      kind: "exited",
      message: "The backend exited with code 3221225477.",
      log: "",
      at: 5,
    });
  });
});
