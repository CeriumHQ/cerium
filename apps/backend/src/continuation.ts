import { continuationBrief, type ContinuationContext } from "@cerium/orchestrator";
import { LEAD_ROLE, type EventPayload, type ThreadId, type ThreadInfo } from "@cerium/protocol";
import type { Store } from "@cerium/store";
import { Effect, Option } from "effect";

import type { Git } from "./git.ts";
import type { GitHub } from "./github.ts";
import { pullRequests } from "./githubPulls.ts";

// The brief a thread that continues another starts with, gathered from what Cerium already holds:
// the old lead's events, and its folder's git and pull request. No model is asked.

/** The events the brief reads; rewinds too, so what they replaced is left out. */
const BRIEF_TAGS: ReadonlyArray<EventPayload["_tag"]> = [
  "MessageQueued",
  "TurnInput",
  "MessageCompleted",
  "TodosUpdated",
  "ConversationRewound",
];

/** How long each look at git or GitHub may take before the brief goes without it. */
const LOOK_TIMEOUT = "8 seconds";

export const continuations = (store: Store["Service"], git: Git["Service"], github: GitHub["Service"]) => {
  const pulls = pullRequests(github);

  /** Where the folder's branch stands; what git or GitHub didn't answer is left out. */
  const workspaceOf = Effect.fn("Continuations.workspaceOf")(function* (thread: ThreadInfo, cwd: string) {
    // Only the end is trimmed: `git status --short` starts a line with a space.
    const look = (args: ReadonlyArray<string>) =>
      git.run(cwd, args, { look: true, timeout: LOOK_TIMEOUT }).pipe(
        Effect.map(({ stdout, code }) => (code === 0 ? stdout.trimEnd() : undefined)),
        Effect.orElseSucceed(() => undefined),
      );
    const branch = (yield* look(["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
    if (branch === undefined || branch === "" || branch === "HEAD") return {};
    // A thread without a worktree of its own counts from the remote's default branch.
    const base =
      thread.worktree?.base ?? (yield* look(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
    const counted = base !== undefined && base !== "" && base !== branch ? base : undefined;
    const [commits, status, pull] = yield* Effect.all(
      [
        counted === undefined ? Effect.void : look(["log", "--oneline", `${counted}..HEAD`]),
        look(["status", "--short"]),
        pulls.forBranch(cwd).pipe(
          Effect.timeout(LOOK_TIMEOUT),
          Effect.map((found) => ("pullRequest" in found ? found.pullRequest : undefined)),
          Effect.orElseSucceed(() => undefined),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      branch,
      ...(counted === undefined ? {} : { base: counted }),
      ...(commits === undefined ? {} : { commits }),
      ...(status === undefined ? {} : { status }),
      ...(pull === undefined
        ? {}
        : {
            pullRequest: {
              number: pull.number,
              title: pull.title,
              url: pull.url,
              state: pull.state,
              draft: pull.draft,
            },
          }),
    } satisfies Omit<ContinuationContext, "title">;
  });

  return {
    /** The brief for the thread that continues `threadId`. */
    briefFor: Effect.fn("Continuations.briefFor")(function* (threadId: ThreadId) {
      const thread = Option.getOrUndefined(yield* store.getThread(threadId));
      if (thread === undefined) return "";
      const lead = (yield* store.listAgents(threadId)).find(
        (agent) => agent.parentId === undefined && agent.role === LEAD_ROLE,
      );
      const events = lead === undefined ? [] : yield* store.listEvents(lead.id, { tags: BRIEF_TAGS });
      const workspace =
        thread.mode === "work" && thread.cwd !== undefined ? yield* workspaceOf(thread, thread.cwd) : {};
      return continuationBrief(events, { title: thread.title, ...workspace });
    }),
  };
};
