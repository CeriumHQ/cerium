import { useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

/** Whether the window has what it shows first, so the launch screen can give way; it stays so. */
export const launchedAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Lifts the launch screen once `ready`: whichever part of the window shows first says when. */
export const useLaunched = (ready: boolean) => {
  const setLaunched = useAtomSet(launchedAtom);
  useEffect(() => {
    if (ready) setLaunched(true);
  }, [ready, setLaunched]);
};

/** How far the window is in starting, as the launch screen tells it. */
export interface LaunchState {
  /** This device's own side answers: a desktop's backend, or the web client's page. */
  readonly backend: boolean;
  /** Whether this device is signed in to an account, and to which, is known. */
  readonly account: boolean;
  /** The machine the window drives answers; undefined when that's this computer's own backend. */
  readonly machine: boolean | undefined;
  /** The window has what it shows first. */
  readonly ready: boolean;
}

/**
 * How long each step tends to take, relative to the others: a desktop's backend takes the longest to
 * start, and the account answers from it at once.
 */
const WEIGHTS = { backend: 5, account: 1, machine: 3, ready: 3 } as const;

/** Where the page itself is once it shows: loaded, if nothing else yet. */
const LOADED = 0.06;

/**
 * The share of starting that's done, and the share the step under way adds once it is. Steps go in
 * order: a later one done before an earlier counts once the earlier is.
 */
export const launchProgress = (state: LaunchState): { readonly done: number; readonly next: number } => {
  if (state.ready) return { done: 1, next: 0 };
  const steps = [
    [state.backend, WEIGHTS.backend],
    [state.account, WEIGHTS.account],
    ...(state.machine === undefined ? [] : [[state.machine, WEIGHTS.machine] as const]),
    [false, WEIGHTS.ready],
  ] as const;
  const total = steps.reduce((sum, [, weight]) => sum + weight, 0);
  const pending = steps.findIndex(([done]) => !done);
  const done = steps.slice(0, pending).reduce((sum, [, weight]) => sum + weight, 0);
  const share = (weight: number) => (weight / total) * (1 - LOADED);
  return { done: LOADED + share(done), next: share(steps[pending]![1]) };
};

/** How far behind the letter before it each letter of the name fills out, as a share of starting. */
const LETTER_LAG = 0.03;

/**
 * How one letter of the launch screen's name looks at `progress` (0 to 1): thin and condensed at the
 * start, the brand's semibold at its expanded width once starting is done, each letter a little behind
 * the one before it. Width and weight are the display face's own axes.
 */
export const letterShape = (
  progress: number,
  index: number,
): { readonly stretch: number; readonly weight: number; readonly opacity: number } => {
  const share = Math.min(1, Math.max(0, (progress - index * LETTER_LAG) / (1 - 5 * LETTER_LAG)));
  const formed = share ** 1.35;
  return {
    stretch: 50 + 75 * formed,
    weight: Math.round(200 + 400 * formed),
    opacity: 0.3 + 0.7 * formed,
  };
};

/** What the launch screen says starting is waiting on, once it takes long enough to wonder. */
export const launchStatus = (state: LaunchState, options: { web: boolean; machineName?: string }): string => {
  if (!state.backend) return "Starting Cerium";
  if (!state.account) return options.web ? "Connecting" : "Starting Cerium";
  if (state.machine === false)
    return options.machineName ? `Connecting to ${options.machineName}` : "Connecting";
  return "Opening your threads";
};
