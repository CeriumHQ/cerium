import type { TurnFilesReverted } from "./events.ts";

export interface TurnFileState {
  /** The last successful restore put this path back to its state before the turn. */
  readonly undone: boolean;
  /** The latest attempt left this path alone because it had changed since. */
  readonly kept: boolean;
  /** Whole-turn requests advance the turn's direction even for files they had to keep. */
  readonly turnUndone: boolean;
}

/** Applies the event to the affected paths, keeping the state of other paths in the turn. */
export const applyTurnFileRevert = (
  previous: ReadonlyMap<string, TurnFileState> | undefined,
  { direction, paths, kept, partial }: TurnFilesReverted,
): ReadonlyMap<string, TurnFileState> => {
  const next = new Map(previous);
  const undone = direction === "undone";
  for (const path of paths) next.set(path, { undone, kept: false, turnUndone: undone });
  for (const path of kept) {
    const state = next.get(path);
    next.set(path, {
      undone: state?.undone ?? false,
      kept: true,
      turnUndone: partial ? (state?.turnUndone ?? false) : undone,
    });
  }
  return next;
};
