import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useRef } from "react";

import { isIssueChanged, issueKey, refreshIssue } from "../../backend/issues.ts";
import { isRateLimited, useRefresh } from "../github/useRefresh.ts";
import { FRESHNESS } from "./model.ts";

/**
 * Keeps an open issue current without spending the user's GitHub requests. Every so often it asks the
 * machine whether the issue changed since `revision`, a question that costs one small request, and
 * reads the whole issue again only when the answer is yes. A full read still happens now and then, for
 * edits and reactions that don't change the revision, and once the window returns after a long time
 * away. A hidden window asks nothing, and a spent rate limit pauses the questions for a while.
 */
export function useIssueFreshness(cwd: string, number: number, revision: string | undefined) {
  const registry = useContext(RegistryContext);
  const ask = useAtomSet(isIssueChanged, { mode: "promise" });
  const pausedUntil = useRef(0);

  const probe = async () => {
    if (revision === undefined || Date.now() < pausedUntil.current) return;
    try {
      const { changed } = await ask({ payload: { cwd, number, revision } });
      if (changed) refreshIssue(registry, issueKey(cwd, number));
    } catch (cause) {
      if (isRateLimited(cause)) pausedUntil.current = Date.now() + FRESHNESS.pause;
    }
  };

  useRefresh(() => void probe(), FRESHNESS.ask, FRESHNESS.askAfter);

  useRefresh(
    () => {
      if (Date.now() >= pausedUntil.current) refreshIssue(registry, issueKey(cwd, number));
    },
    FRESHNESS.read,
    FRESHNESS.read,
  );
}
