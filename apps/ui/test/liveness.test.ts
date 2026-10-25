import { afterEach, assert, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { liveness, UNREACHABLE_AFTER_MS, type ConnectionState } from "../src/backend/liveness.ts";

const setup = () => {
  const registry = AtomRegistry.make();
  const state = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);
  const epoch = Atom.make(0).pipe(Atom.keepAlive);
  const live = liveness(registry, state, epoch);
  return { registry, live, state: () => registry.get(state), epoch: () => registry.get(epoch) };
};

describe("liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps reads through a dropped line and moves them on once it's back", () => {
    const { live, state, epoch } = setup();
    live.connected();
    expect(state()).toBe("connected");
    const connectedEpoch = epoch();
    live.lost();
    expect(state()).toBe("reconnecting");
    expect(epoch()).toBe(connectedEpoch);
    live.connected();
    expect(state()).toBe("connected");
    expect(epoch()).toBe(connectedEpoch + 1);
  });

  it("turns unreachable once the line stays lost", () => {
    const { live, state, epoch } = setup();
    live.connected();
    live.lost();
    const lostEpoch = epoch();
    vi.advanceTimersByTime(UNREACHABLE_AFTER_MS);
    expect(state()).toBe("unreachable");
    expect(epoch()).toBe(lostEpoch + 1);
  });

  it("counts a first connection that fails as connecting, not reconnecting", () => {
    const { live, state } = setup();
    live.lost();
    expect(state()).toBe("connecting");
  });

  it("starts over on a machine switch", () => {
    const { live, state, epoch } = setup();
    live.connected();
    live.lost();
    const before = epoch();
    live.restart();
    expect(state()).toBe("connecting");
    expect(epoch()).toBe(before + 1);
  });

  it("opens again at once after a steady connection, however many came before", () => {
    const { live } = setup();
    expect([live.nextRetry(), live.nextRetry(), live.nextRetry(), live.nextRetry()]).toEqual([
      0, 250, 500, 1000,
    ]);
    for (let drop = 0; drop < 10; drop++) {
      live.connected();
      vi.advanceTimersByTime(60_000);
      live.lost();
      expect(live.nextRetry()).toBe(0);
    }
  });

  it("backs off from a connection that drops as soon as it's up", () => {
    const { live } = setup();
    const delays: Array<number> = [];
    for (let drop = 0; drop < 8; drop++) {
      live.connected();
      live.lost();
      delays.push(live.nextRetry());
    }
    expect(delays).toEqual([0, 250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});

// Effect's scheduler runs on real timers.
describe("liveness.settled", () => {
  it.effect("holds calls while the line comes back, and lets them go once it's back", () =>
    Effect.gen(function* () {
      const { live } = setup();
      yield* live.settled;
      live.connected();
      live.lost();
      const waiting = yield* Effect.forkChild(live.settled);
      yield* Effect.yieldNow;
      assert.isUndefined(waiting.pollUnsafe());
      live.connected();
      yield* Fiber.join(waiting);
    }),
  );
});
