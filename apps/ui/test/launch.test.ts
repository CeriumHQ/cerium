import { describe, expect, it } from "@effect/vitest";

import { launchProgress, launchStatus, type LaunchState } from "../src/app/launch.ts";

const starting: LaunchState = { backend: false, account: false, machine: undefined, ready: false };

describe("launchProgress", () => {
  it("starts past nothing, with the backend as the next step", () => {
    const { done, next } = launchProgress(starting);
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(0.1);
    expect(next).toBeGreaterThan(0.3);
  });

  it("grows with each step and is full once the window is ready", () => {
    const backend = launchProgress({ ...starting, backend: true });
    const account = launchProgress({ ...starting, backend: true, account: true });
    expect(backend.done).toBeGreaterThan(launchProgress(starting).done);
    expect(account.done).toBeGreaterThan(backend.done);
    expect(account.done + account.next).toBeCloseTo(1);
    expect(launchProgress({ ...starting, ready: true })).toEqual({ done: 1, next: 0 });
  });

  it("counts a later step only once the earlier ones are done", () => {
    expect(launchProgress({ ...starting, account: true })).toEqual(launchProgress(starting));
  });

  it("makes room for reaching another machine", () => {
    const local = launchProgress({ ...starting, backend: true, account: true });
    const driven = launchProgress({ ...starting, backend: true, account: true, machine: false });
    expect(driven.done).toBeLessThan(local.done);
    expect(launchProgress({ ...starting, backend: true, account: true, machine: true }).done).toBeGreaterThan(
      driven.done,
    );
  });
});

describe("launchStatus", () => {
  it("says what starting waits on", () => {
    expect(launchStatus(starting, { web: false })).toBe("Starting Cerium");
    expect(launchStatus({ ...starting, backend: true }, { web: true })).toBe("Connecting");
    expect(
      launchStatus(
        { ...starting, backend: true, account: true, machine: false },
        { web: true, machineName: "Desk" },
      ),
    ).toBe("Connecting to Desk");
    expect(launchStatus({ ...starting, backend: true, account: true }, { web: false })).toBe(
      "Opening your threads",
    );
  });
});
