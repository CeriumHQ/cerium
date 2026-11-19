import type { ProviderId } from "@cerium/protocol";

import { providerName } from "../threads/model.ts";

// Forking a thread from one of the user's messages: a new sibling thread that carries the
// conversation up to there, and leaves this one as it is.

/** Where the fork's agents work: this thread's own checkout, or a new worktree with the files as they were. */
export type ForkWorkspace = "current" | "worktree";

/** What the dialog asks the backend for; `harness` and `model` are absent while they stay the same. */
export interface ForkRequest {
  /** The selected turn, including its reply. */
  readonly turn: string;
  /** Absent for a chat, which has no files. */
  readonly workspace?: ForkWorkspace;
  readonly harness?: ProviderId;
  readonly model?: string;
}

/** What a message's fork menu item and dialog work from. */
export interface ForkActions {
  /** The thread has a folder its agents work in: the workspace choice is offered. */
  readonly folder: string | undefined;
  /** The machine can give a thread a worktree of its own. */
  readonly worktrees: boolean;
  /** The lead's harness and model, which the fork keeps unless another is picked. */
  readonly provider: ProviderId;
  readonly model: string;
  /** The harnesses ready to run a thread. */
  readonly available: ReadonlySet<ProviderId>;
  /** Reads whether the turn's end has a snapshot of the files, which a worktree is made from. */
  readonly preview: (turn: string) => Promise<{ readonly snapshot: boolean }>;
  /** Forks, and opens the sibling; rejects with the reason it couldn't. */
  readonly fork: (request: ForkRequest) => Promise<void>;
}

/** What the workspace choice has to say, as far as the thread and its message show. */
export type ForkCheck =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly snapshot: boolean }
  /** The read failed, so a worktree can't be promised; the current workspace still can. */
  | { readonly status: "failed" };

/** Whether a workspace can be picked, and when it can't, why, in a short phrase. */
export interface Offer {
  readonly available: boolean;
  readonly reason?: string;
}

export const workspaceOffers = (
  actions: Pick<ForkActions, "folder" | "worktrees">,
  check: ForkCheck,
): Record<ForkWorkspace, Offer> => {
  const current: Offer =
    actions.folder === undefined
      ? { available: false, reason: "This thread has no folder" }
      : { available: true };
  if (actions.folder === undefined) return { current, worktree: current };
  if (!actions.worktrees) {
    return { current, worktree: { available: false, reason: "This machine can't make worktrees" } };
  }
  if (check.status === "loading") {
    return { current, worktree: { available: false, reason: "Checking the files…" } };
  }
  if (check.status === "failed") {
    return {
      current,
      worktree: { available: false, reason: "Couldn't check the files, so this can't be offered now" },
    };
  }
  return check.snapshot
    ? { current, worktree: { available: true } }
    : { current, worktree: { available: false, reason: "No files were saved at the end of this turn" } };
};

/** The reason a fork couldn't be made, as the backend told it. */
const reasonOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "";

/** What went wrong, and what the user can do about it. */
export interface ForkFailure {
  readonly message: string;
  /** The worktree was the problem, so forking in the same workspace is worth offering. */
  readonly worktree: boolean;
}

export const forkFailure = (error: unknown, workspace: ForkWorkspace | undefined): ForkFailure => {
  const reason = reasonOf(error).trim();
  const fallback = "Couldn't fork this thread. Try again in a moment.";
  const message = reason === "" ? fallback : /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return { message, worktree: workspace === "worktree" };
};

/** A line about the harness the fork runs on, when it isn't this thread's own. */
export const harnessLine = (from: ProviderId, to: ProviderId): string | undefined =>
  from === to
    ? undefined
    : `${providerName[to]} starts a new session with a brief of the conversation through this turn.`;
