import { Effect } from "effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

/**
 * `reconnecting` is a line to the same machine dropped a moment ago: what the window shows of it
 * stays, and calls wait for the line to come back rather than fail.
 */
export type ConnectionState = "connecting" | "reconnecting" | "connected" | "unreachable";

/**
 * How long a connection may stay lost, or a switch take, before the machine counts as unreachable.
 * Reconnecting after a dropped line, or a phone coming back to the app, usually takes a moment that
 * says nothing about the machine.
 */
export const UNREACHABLE_AFTER_MS = 8_000;

/** A connection that stayed up this long dropped on its own, and the next one may open at once. */
const STEADY_FOR_MS = 5_000;

/**
 * A connection's state, which only turns unreachable once it has stayed lost for a while, and how
 * soon to open the next. The RPC client keeps one retry schedule for its whole life, which never
 * learns that a connection came up: without starting over here, a phone back from the background
 * a few times waited five seconds before even trying. `epoch` moves on with every change of state
 * but a line dropping.
 */
export const liveness = (
  registry: AtomRegistry.AtomRegistry,
  state: Atom.Writable<ConnectionState>,
  epoch?: Atom.Writable<number>,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectedAt: number | undefined;
  let failures = 0;
  const become = (next: ConnectionState) => {
    if (registry.get(state) === next) return;
    registry.set(state, next);
    if (epoch !== undefined && next !== "reconnecting") registry.update(epoch, (current) => current + 1);
  };
  const lost = () => {
    if (timer !== undefined || registry.get(state) === "unreachable") return;
    if (registry.get(state) === "connected") become("reconnecting");
    timer = setTimeout(() => {
      timer = undefined;
      become("unreachable");
    }, UNREACHABLE_AFTER_MS);
  };
  return {
    connected: () => {
      clearTimeout(timer);
      timer = undefined;
      connectedAt = Date.now();
      become("connected");
    },
    lost,
    /** Starts over, as for a machine just switched to. */
    restart: () => {
      clearTimeout(timer);
      timer = undefined;
      become("connecting");
      lost();
    },
    /**
     * Milliseconds until the next open: none after a steady connection, then a quarter second
     * doubling to five. A tunnel's open waits for the relay itself, so going at once costs nothing.
     */
    nextRetry: () => {
      if (connectedAt !== undefined && Date.now() - connectedAt >= STEADY_FOR_MS) failures = 0;
      connectedAt = undefined;
      const attempt = failures++;
      return attempt === 0 ? 0 : Math.min(5_000, 250 * 2 ** (attempt - 1));
    },
    /** Waits while the line is coming back; at once otherwise. */
    settled: Effect.callback<void>((resume) => {
      if (registry.get(state) !== "reconnecting") return resume(Effect.void);
      const stop = registry.subscribe(state, (now) => {
        if (now === "reconnecting") return;
        stop();
        resume(Effect.void);
      });
      return Effect.sync(stop);
    }),
  };
};
export type Liveness = ReturnType<typeof liveness>;
