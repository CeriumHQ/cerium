import type { MergeMethod, ReviewEvent } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useRef, useState } from "react";

import {
  addGitHubComment,
  checkoutPull,
  isPullChanged,
  mergePull,
  refreshPull,
  replyToReviewThread,
  resolveReviewThread,
  setPullDraft,
  setPullState,
  submitReview,
} from "../../backend/github.ts";
import { isRateLimited, useRefresh } from "./useRefresh.ts";

/** How often an open pull request asks whether it changed, and reads itself whole. */
export const PULL_FRESHNESS = {
  /** Between questions whether it changed. */
  ask: 30_000,
  /** Between questions while its checks run, which change by the minute. */
  askRunning: 12_000,
  /** The shortest time away after which the window's return asks at once. */
  askAfter: 15_000,
  /** Between full readings, which catch edits and reactions the question can't see. */
  read: 5 * 60_000,
  /** How long a spent rate limit pauses the questions. */
  pause: 5 * 60_000,
} as const;

/** GitHub's search takes a few seconds to list a change; the list is read once more after it. */
const SEARCH_LAG = 4_000;

/**
 * Keeps an open pull request current without spending the user's GitHub requests: every so often it
 * asks the machine whether the pull request changed since `revision`, which costs one small request,
 * and reads it again only when it did; more often while its checks run. A full reading still happens
 * now and then. A hidden window asks nothing, and a spent rate limit pauses the questions.
 */
export function usePullFreshness(
  cwd: string,
  number: number,
  revision: string | undefined,
  checksRunning: boolean,
) {
  const registry = useContext(RegistryContext);
  const ask = useAtomSet(isPullChanged, { mode: "promise" });
  const pausedUntil = useRef(0);

  const probe = async () => {
    if (revision === undefined || Date.now() < pausedUntil.current) return;
    try {
      const { changed } = await ask({ payload: { cwd, number, revision } });
      if (changed) refreshPull(registry, cwd, number);
    } catch (cause) {
      if (isRateLimited(cause)) pausedUntil.current = Date.now() + PULL_FRESHNESS.pause;
    }
  };

  useRefresh(
    () => void probe(),
    checksRunning ? PULL_FRESHNESS.askRunning : PULL_FRESHNESS.ask,
    PULL_FRESHNESS.askAfter,
  );
  useRefresh(
    () => {
      if (Date.now() >= pausedUntil.current) refreshPull(registry, cwd, number);
    },
    PULL_FRESHNESS.read,
    PULL_FRESHNESS.read,
  );
}

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "GitHub couldn't do that.";

/** What's being done to a pull request now. */
export type PullAction =
  | "comment"
  | "reply"
  | "resolve"
  | "review"
  | "merge"
  | "state"
  | "draft"
  | "checkout";

export interface PullActions {
  /** What is being done now; the actions wait their turn. */
  readonly busy: PullAction | undefined;
  /** Why the last action failed, in words for the user. */
  readonly error: string | undefined;
  readonly dismiss: () => void;
  /** Each resolves with whether it worked; the user has been told when it didn't. */
  readonly comment: (body: string) => Promise<boolean>;
  readonly reply: (thread: string, body: string) => Promise<boolean>;
  readonly resolve: (thread: string, resolved: boolean) => Promise<boolean>;
  readonly review: (event: ReviewEvent, body: string) => Promise<boolean>;
  readonly merge: (method: MergeMethod, headOid: string, deleteBranch: boolean) => Promise<boolean>;
  readonly setState: (state: "open" | "closed") => Promise<boolean>;
  readonly setDraft: (draft: boolean) => Promise<boolean>;
  /** Resolves with the branch checked out, or undefined when it couldn't be. */
  readonly checkout: () => Promise<string | undefined>;
}

/**
 * What the user can do to one pull request. A backend action takes one call at a time, so these wait
 * their turn; the pull request and the list are read again after each, whether it worked or not.
 */
export function usePullActions(cwd: string, number: number): PullActions {
  const registry = useContext(RegistryContext);
  const sendComment = useAtomSet(addGitHubComment, { mode: "promise" });
  const sendReply = useAtomSet(replyToReviewThread, { mode: "promise" });
  const sendResolve = useAtomSet(resolveReviewThread, { mode: "promise" });
  const sendReview = useAtomSet(submitReview, { mode: "promise" });
  const sendMerge = useAtomSet(mergePull, { mode: "promise" });
  const sendState = useAtomSet(setPullState, { mode: "promise" });
  const sendDraft = useAtomSet(setPullDraft, { mode: "promise" });
  const sendCheckout = useAtomSet(checkoutPull, { mode: "promise" });
  const [busy, setBusy] = useState<PullAction>();
  const [error, setError] = useState<string>();
  const running = useRef(false);

  const run = async <A>(
    name: PullAction,
    work: () => Promise<A>,
  ): Promise<{ readonly done: A } | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(name);
    setError(undefined);
    try {
      const done = await work();
      setTimeout(() => refreshPull(registry, cwd, number), SEARCH_LAG);
      return { done };
    } catch (cause) {
      setError(messageOf(cause));
      return undefined;
    } finally {
      running.current = false;
      setBusy(undefined);
      refreshPull(registry, cwd, number);
    }
  };
  const worked = async (name: PullAction, work: () => Promise<unknown>) =>
    (await run(name, work)) !== undefined;

  return {
    busy,
    error,
    dismiss: () => setError(undefined),
    comment: (body) => worked("comment", () => sendComment({ payload: { cwd, number, body } })),
    reply: (thread, body) => worked("reply", () => sendReply({ payload: { cwd, thread, body } })),
    resolve: (thread, resolved) =>
      worked("resolve", () => sendResolve({ payload: { cwd, thread, resolved } })),
    review: (event, body) => worked("review", () => sendReview({ payload: { cwd, number, event, body } })),
    merge: (method, headOid, deleteBranch) =>
      worked("merge", () => sendMerge({ payload: { cwd, number, method, headOid, deleteBranch } })),
    setState: (state) => worked("state", () => sendState({ payload: { cwd, number, state } })),
    setDraft: (draft) => worked("draft", () => sendDraft({ payload: { cwd, number, draft } })),
    checkout: async () =>
      (await run("checkout", () => sendCheckout({ payload: { cwd, number } })))?.done.branch,
  };
}
