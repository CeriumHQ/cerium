import type { CloseReason } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useRef, useState } from "react";

import {
  closeIssue,
  commentOnIssue,
  issueKey,
  refreshIssue,
  refreshIssueList,
  reopenIssue,
  updateIssue,
} from "../../backend/issues.ts";
import { SEARCH_LAG } from "./model.ts";

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "GitHub couldn't do that.";

/** Changes to an issue's labels and assignees, by name. */
export interface IssueChanges {
  readonly addLabels?: ReadonlyArray<string>;
  readonly removeLabels?: ReadonlyArray<string>;
  readonly addAssignees?: ReadonlyArray<string>;
  readonly removeAssignees?: ReadonlyArray<string>;
}

export interface IssueActions {
  /** What is being done now; the actions wait their turn. */
  readonly busy: string | undefined;
  /** Why the last action failed, in words for the user. */
  readonly error: string | undefined;
  readonly dismiss: () => void;
  /** Each resolves with whether it worked; the user has been told when it didn't. */
  readonly comment: (body: string) => Promise<boolean>;
  readonly close: (reason: CloseReason, comment?: string) => Promise<boolean>;
  readonly reopen: () => Promise<boolean>;
  readonly update: (changes: IssueChanges) => Promise<boolean>;
}

/**
 * What the user can do to one issue. A backend action takes one call at a time, so these wait their
 * turn; the issue and the list are read again after each, whether it worked or not.
 */
export function useIssueActions(cwd: string, number: number): IssueActions {
  const registry = useContext(RegistryContext);
  const send = useAtomSet(commentOnIssue, { mode: "promise" });
  const closeOne = useAtomSet(closeIssue, { mode: "promise" });
  const reopenOne = useAtomSet(reopenIssue, { mode: "promise" });
  const change = useAtomSet(updateIssue, { mode: "promise" });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const running = useRef(false);

  const run = async (name: string, work: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(name);
    setError(undefined);
    try {
      await work();
      // GitHub's search takes a few seconds to catch up, so the list is read once more after it.
      setTimeout(() => refreshIssueList(registry, cwd), SEARCH_LAG);
      return true;
    } catch (cause) {
      setError(messageOf(cause));
      return false;
    } finally {
      running.current = false;
      setBusy(undefined);
      refreshIssue(registry, issueKey(cwd, number));
      refreshIssueList(registry, cwd);
    }
  };

  return {
    busy,
    error,
    dismiss: () => setError(undefined),
    comment: (body) => run("comment", () => send({ payload: { cwd, number, body } })),
    close: (reason, comment) =>
      run("close", () =>
        closeOne({
          payload: {
            cwd,
            number,
            reason,
            ...(comment === undefined || comment.trim() === "" ? {} : { comment }),
          },
        }),
      ),
    reopen: () => run("reopen", () => reopenOne({ payload: { cwd, number } })),
    update: (changes) => run("update", () => change({ payload: { cwd, number, ...changes } })),
  };
}
