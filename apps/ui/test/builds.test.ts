import { MIN_RPC_VERSION, RPC_VERSION } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import { buildAddress, buildToMoveTo } from "../src/web/builds.ts";

const current = { version: "2.0.0", rpcVersion: RPC_VERSION };

describe("which build the web client runs", () => {
  it("stays on its build for a desktop of the same version", () => {
    expect(buildToMoveTo({ version: "2.0.0", rpcVersion: RPC_VERSION }, current)).toBeUndefined();
    expect(buildToMoveTo(undefined, current)).toBeUndefined();
  });

  it("stays on its build for an older desktop it reads", () => {
    expect(buildToMoveTo({ version: "1.9.0", rpcVersion: RPC_VERSION - 1 }, current)).toBeUndefined();
    expect(buildToMoveTo({ version: "1.0.0", rpcVersion: MIN_RPC_VERSION }, current)).toBeUndefined();
    expect(buildToMoveTo({ version: "2.0.1", rpcVersion: RPC_VERSION }, current)).toBeUndefined();
  });

  it("moves to a newer desktop's build, or one that doesn't say what it speaks", () => {
    expect(buildToMoveTo({ version: "2.1.0", rpcVersion: RPC_VERSION + 1 }, current)).toBe("2.1.0");
    expect(buildToMoveTo({ version: "0.9.0" }, current)).toBe("0.9.0");
  });
});

describe("where a build opens", () => {
  const none = new URLSearchParams();

  it("takes the open thread there, with its machine", () => {
    expect(buildAddress("1.2.3", { thread: "thr_1", machine: "desk" }, none)).toBe(
      "/v/1.2.3/?machine=desk&thread=thr_1",
    );
    expect(buildAddress("1.2.3", { thread: "thr_1" }, none)).toBe("/v/1.2.3/?thread=thr_1");
  });

  it("takes the thread and machine a tapped notification opened Cerium for", () => {
    const launched = new URLSearchParams({ machine: "laptop", thread: "thr_9" });
    expect(buildAddress("1.2.3", { machine: "desk" }, launched)).toBe(
      "/v/1.2.3/?machine=laptop&thread=thr_9",
    );
    // The open thread goes with its own machine, not the tapped one's.
    expect(buildAddress("1.2.3", { thread: "thr_1", machine: "desk" }, launched)).toBe(
      "/v/1.2.3/?machine=desk&thread=thr_1",
    );
  });

  it("carries no machine without a thread", () => {
    expect(buildAddress("1.2.3", { machine: "desk" }, none)).toBe("/v/1.2.3/");
  });
});
