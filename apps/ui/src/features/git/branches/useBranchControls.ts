import type { GitBranchState, OperationAction, PushMode, ResolveSide, SwitchChanges } from "@cerium/rpc";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import {
  branchBusyAtom,
  branchMessageAtom,
  branchStateAtom,
  fetchedAtAtom,
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitMerge,
  gitOperation,
  gitPull,
  gitPush,
  gitRenameBranch,
  gitResolve,
  gitSetUpstream,
  gitStash,
  gitStashApply,
  gitStashDrop,
  gitSwitch,
  refreshBranches,
  type BranchMessage,
} from "../../../backend/branches.ts";
import { refreshGitStatus } from "../../../backend/git.ts";

/** How long a piece of news stays up before it goes. */
const NEWS_MS = 4_000;

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Git couldn't do that.";

export interface BranchControls {
  /** Where the repository stands; none until the machine has said. */
  readonly state: GitBranchState | undefined;
  /** What is being changed now, by name; the controls wait their turn. */
  readonly busy: string | undefined;
  readonly message: BranchMessage | undefined;
  readonly dismiss: () => void;
  readonly fetch: () => Promise<boolean>;
  readonly pull: () => Promise<boolean>;
  readonly push: (mode: PushMode) => Promise<boolean>;
  readonly switchTo: (branch: string, changes: SwitchChanges) => Promise<boolean>;
  readonly createBranch: (
    name: string,
    options: { readonly from?: string; readonly switch: boolean; readonly changes: SwitchChanges },
  ) => Promise<boolean>;
  readonly renameBranch: (branch: string, name: string) => Promise<boolean>;
  /** Deletes a branch; `unmerged` is how many commits stopped it, when git wouldn't without `force`. */
  readonly deleteBranch: (
    branch: string,
    force: boolean,
  ) => Promise<{ readonly unmerged?: number } | undefined>;
  readonly setUpstream: (branch: string, upstream: string | undefined) => Promise<boolean>;
  readonly stash: (message: string, includeUntracked: boolean) => Promise<boolean>;
  readonly applyStash: (commit: string, pop: boolean) => Promise<boolean>;
  readonly dropStash: (commit: string) => Promise<boolean>;
  readonly merge: (branch: string) => Promise<boolean>;
  readonly operation: (action: OperationAction) => Promise<boolean>;
  readonly resolve: (path: string, side: ResolveSide) => Promise<boolean>;
}

/**
 * What Source control's header and banner do to the repository `root` is in: each change runs one at a
 * time, tells the user how it went, and has the machine's view of the repository read again.
 */
export function useBranchControls(root: string): BranchControls {
  const registry = useContext(RegistryContext);
  const state = Option.getOrUndefined(AsyncResult.value(useAtomValue(branchStateAtom(root))));
  const busy = useAtomValue(branchBusyAtom(root));
  const message = useAtomValue(branchMessageAtom(root));

  const switchBranch = useAtomSet(gitSwitch, { mode: "promise" });
  const create = useAtomSet(gitCreateBranch, { mode: "promise" });
  const rename = useAtomSet(gitRenameBranch, { mode: "promise" });
  const remove = useAtomSet(gitDeleteBranch, { mode: "promise" });
  const upstream = useAtomSet(gitSetUpstream, { mode: "promise" });
  const fetchAll = useAtomSet(gitFetch, { mode: "promise" });
  const pullBranch = useAtomSet(gitPull, { mode: "promise" });
  const pushBranch = useAtomSet(gitPush, { mode: "promise" });
  const stashChanges = useAtomSet(gitStash, { mode: "promise" });
  const applyOne = useAtomSet(gitStashApply, { mode: "promise" });
  const dropOne = useAtomSet(gitStashDrop, { mode: "promise" });
  const mergeBranch = useAtomSet(gitMerge, { mode: "promise" });
  const continueOperation = useAtomSet(gitOperation, { mode: "promise" });
  const settle = useAtomSet(gitResolve, { mode: "promise" });

  const say = (next: BranchMessage | undefined) => {
    registry.set(branchMessageAtom(root), next);
    if (next?.tone === "info") {
      // News goes by itself, unless something newer replaced it.
      setTimeout(
        () => registry.update(branchMessageAtom(root), (current) => (current === next ? undefined : current)),
        NEWS_MS,
      );
    }
  };

  /**
   * Runs one change, unless another is under way; `report` turns its result into what the user is told.
   * Resolves with the result in a box (some changes have none to give), or undefined when it failed
   * (the user has been told why) or didn't run.
   */
  const run = async <A>(
    name: string,
    work: () => Promise<A>,
    report: (result: A) => BranchMessage | undefined,
  ): Promise<{ readonly value: A } | undefined> => {
    if (registry.get(branchBusyAtom(root)) !== undefined) return undefined;
    registry.set(branchBusyAtom(root), name);
    registry.set(branchMessageAtom(root), undefined);
    try {
      const result = await work();
      say(report(result));
      return { value: result };
    } catch (error) {
      say({ tone: "error", text: messageOf(error) });
      return undefined;
    } finally {
      registry.set(branchBusyAtom(root), undefined);
      refreshBranches(registry, root);
      refreshGitStatus(registry, root);
    }
  };

  const info = (text: string): BranchMessage => ({ tone: "info", text });
  const stopped = (text: string): BranchMessage => ({ tone: "attention", text });
  /**
   * The words for a result that may have stopped on conflicts or found nothing to do. A stop with no
   * words of its own is told by the banner that takes over, so it is told no further.
   */
  const outcome =
    (done: string, nothing: string, conflicts?: string) =>
    (result: { readonly conflicted?: boolean | undefined; readonly unchanged?: boolean | undefined }) =>
      result.conflicted === true
        ? conflicts === undefined
          ? undefined
          : stopped(conflicts)
        : info(result.unchanged === true ? nothing : done);

  return {
    state,
    busy,
    message,
    dismiss: () => registry.set(branchMessageAtom(root), undefined),
    fetch: async () =>
      (await run(
        "fetch",
        () => fetchAll({ payload: { root } }),
        (result) => {
          registry.set(fetchedAtAtom(root), Date.now());
          return info(result.unchanged === true ? "Already up to date." : "Fetched what's new.");
        },
      )) !== undefined,
    pull: async () =>
      (await run(
        "pull",
        () => pullBranch({ payload: { root } }),
        outcome("Pulled.", "Already up to date."),
      )) !== undefined,
    push: async (mode) =>
      (await run(
        "push",
        () => pushBranch({ payload: { root, mode } }),
        outcome(
          mode === "publish"
            ? "Published the branch."
            : mode === "forceWithLease"
              ? "Force pushed."
              : "Pushed.",
          "Nothing to push.",
        ),
      )) !== undefined,
    switchTo: async (branch, changes) =>
      (await run(
        "switch",
        () => switchBranch({ payload: { root, branch, changes } }),
        () =>
          info(
            changes === "stash"
              ? `Switched to ${branch}. Your changes are in the stash.`
              : `Switched to ${branch}.`,
          ),
      )) !== undefined,
    createBranch: async (name, options) =>
      (await run(
        "create",
        () =>
          create({
            payload: {
              root,
              name,
              switch: options.switch,
              changes: options.changes,
              ...(options.from === undefined ? {} : { from: options.from }),
            },
          }),
        () => info(options.switch ? `Created ${name} and switched to it.` : `Created ${name}.`),
      )) !== undefined,
    renameBranch: async (branch, name) =>
      (await run(
        "rename",
        () => rename({ payload: { root, branch, name } }),
        () => info(`Renamed ${branch} to ${name}.`),
      )) !== undefined,
    deleteBranch: async (branch, force) => {
      const result = await run(
        "delete",
        () => remove({ payload: { root, branch, force } }),
        (deleted) => (deleted._tag === "Deleted" ? info(`Deleted ${branch}.`) : undefined),
      );
      if (result === undefined) return undefined;
      return result.value._tag === "Unmerged" ? { unmerged: result.value.commits } : {};
    },
    setUpstream: async (branch, to) =>
      (await run(
        "upstream",
        () => upstream({ payload: { root, branch, ...(to === undefined ? {} : { upstream: to }) } }),
        () => info(to === undefined ? `${branch} follows no remote branch now.` : `${branch} follows ${to}.`),
      )) !== undefined,
    stash: async (text, includeUntracked) =>
      (await run(
        "stash",
        () =>
          stashChanges({
            payload: {
              root,
              includeUntracked,
              ...(text.trim() === "" ? {} : { message: text.trim() }),
            },
          }),
        (result) =>
          info(
            result.unchanged === true
              ? includeUntracked
                ? "Nothing to stash."
                : "Nothing to stash. New files stay unless you include them."
              : "Stashed your changes.",
          ),
      )) !== undefined,
    applyStash: async (commit, pop) =>
      (await run(
        "stash-apply",
        () => applyOne({ payload: { root, commit, pop } }),
        outcome(
          pop ? "Applied the stash and dropped it." : "Applied the stash.",
          "",
          pop
            ? "Applying the stash stopped on conflicts. The stash is kept. Settle them under Changes."
            : "Applying the stash stopped on conflicts. Settle them under Changes.",
        ),
      )) !== undefined,
    dropStash: async (commit) =>
      (await run(
        "stash-drop",
        () => dropOne({ payload: { root, commit } }),
        () => info("Dropped the stash."),
      )) !== undefined,
    merge: async (branch) =>
      (await run(
        "merge",
        () => mergeBranch({ payload: { root, branch } }),
        outcome(`Merged ${branch}.`, "Already up to date."),
      )) !== undefined,
    operation: async (action) =>
      (await run(
        "operation",
        () => continueOperation({ payload: { root, action } }),
        outcome(action === "abort" ? "Aborted." : "Done.", ""),
      )) !== undefined,
    resolve: async (path, side) =>
      (await run(
        "resolve",
        () => settle({ payload: { root, path, side } }),
        () => undefined,
      )) !== undefined,
  };
}
