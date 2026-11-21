import type { AgentId, InputItem, ThreadId, ThreadWorktree, WorktreeChanges } from "@cerium/protocol";
import { Deferred, Effect, Option, Stream } from "effect";

import type { OrchestratorContext } from "./context.ts";
import { notAllowed, OrchestratorError, refusedWorktree } from "./errors.ts";
import type { PutAwayOptions } from "./inputs.ts";
import type { ScriptEnded, ScriptServed, ScriptStarted, ThreadPorts } from "./scripts.ts";
import type { NewWorktree } from "./services.ts";

/** What a worktree's changes are, in words, for the refusal that asks the user to confirm. */
const describeChanges = ({ uncommitted, unmerged }: WorktreeChanges, base: string) =>
  [
    uncommitted > 0 ? `${uncommitted} uncommitted ${uncommitted === 1 ? "change" : "changes"}` : undefined,
    unmerged > 0 ? `${unmerged} ${unmerged === 1 ? "commit" : "commits"} not merged into ${base}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" and ");

/** What the lead hears when the worktree was made: what setup runs there, or that none is set. */
export const setupNote = (ran: ScriptStarted | undefined): string =>
  ran === undefined
    ? "No setup command is set for this project, so the worktree may lack what it needs. The user can set one in Settings → Git & GitHub; until then, install what's missing yourself."
    : ran._tag === "Ran"
      ? `The project's setup (\`${ran.script}\`) is running in this thread's terminal. Wait for the notice of it finishing or failing before relying on what it installs.`
      : `Cerium guesses the setup \`${ran.script}\` for this project, and a guess never runs by itself: the user was asked in this thread to run it, once or always for this project. You'll be told when it ends. Until then, don't rely on what it installs; if the user doesn't answer, install what you need yourself.`;

/** What the lead hears of the git-ignored files (`.env`, or what `.worktreeinclude` lists) copied in from the project. */
const copiedNote = (copied: ReadonlyArray<string> | undefined): string => {
  if (copied === undefined || copied.length === 0) return "";
  const shown = copied
    .slice(0, 6)
    .map((file) => `\`${file}\``)
    .join(", ");
  return ` Copied from the project into this worktree, since git ignores them: ${shown}${copied.length > 6 ? ` and ${copied.length - 6} more` : ""}.`;
};

/** What the lead hears of the ports its thread's scripts and terminals were given. */
export const portsNote = (ports: ThreadPorts | undefined): string =>
  ports === undefined
    ? ""
    : ` This thread's ports are ${ports.first}–${ports.last}. Its scripts and terminals have the environment variable CERIUM_PORT set to ${ports.first}, and CERIUM_ROOT_PATH to the project's own checkout: use CERIUM_PORT, and the ports after it, for any dev server, test server or database you start, so threads running in this project don't collide.`;

/** What the lead hears when a script's run is over; a failure comes with the last of what it printed. */
const endedNote = (ended: ScriptEnded): string => {
  const what = `The project's ${ended.kind} (\`${ended.script}\`)`;
  if (ended.code === 0) return `${what} finished.`;
  if (ended.code === undefined) return `${what} stopped (its terminal was closed).`;
  return ended.output === undefined
    ? `${what} failed with exit code ${ended.code}; its terminal shows why.`
    : `${what} failed with exit code ${ended.code}. The end of its output:\n\`\`\`\n${ended.output}\n\`\`\``;
};

/** What the lead hears when the project's run prints the address it serves at. */
const servedNote = (served: ScriptServed): string =>
  `The project's ${served.kind} (\`${served.script}\`) is serving at ${served.url}. Open it in your thread's browser with \`browser_open\` to check it, or read its output with \`project_run\`.`;

/**
 * A thread's workspace: checking out, setting up, putting back and removing its worktree, and telling
 * its lead how the project's scripts run there.
 */
export const makeThreadWorkspace = (ctx: OrchestratorContext) => {
  const {
    worktrees,
    scripts,
    fs,
    path,
    layerScope,
    runtimes,
    threadWorktrees,
    checkouts,
    heldNotices,
    deliver,
    holdNotice,
    stopThreadAgents,
  } = ctx;

  // A script's run ending reaches its thread's lead as any notice does, so it knows when the
  // setup is through: without one, its work would race the install. The run's own news, where it
  // serves and how it ended, wakes no idle lead: a Run the user pressed isn't worth a turn that
  // rereads a context of hundreds of thousands of tokens. It waits for the lead's next turn, a
  // newer one replacing an older that it would only contradict, and a lead mid-turn hears it as
  // any notice.
  const heldRunNotices = new WeakSet<InputItem>();
  const tellLead = (threadId: ThreadId, text: string, options: { readonly wakes: boolean }) =>
    Effect.forEach(
      [...runtimes.values()].filter((rt) => rt.info.threadId === threadId && rt.info.parentId === undefined),
      (rt) => {
        const notice: InputItem = { _tag: "SystemNotice", text };
        if (options.wakes || rt.info.state !== "idle") return deliver(rt.info.id, notice);
        return Effect.sync(() => {
          heldRunNotices.add(notice);
          const earlier = (heldNotices.get(rt.info.id) ?? []).filter((item) => !heldRunNotices.has(item));
          heldNotices.set(rt.info.id, [...earlier, notice]);
        });
      },
      { discard: true },
    );
  const forwardScriptNews = Effect.gen(function* () {
    yield* scripts.ended.pipe(
      Stream.runForEach((ended) =>
        tellLead(ended.threadId, endedNote(ended), { wakes: ended.kind !== "run" }),
      ),
      Effect.forkIn(layerScope),
    );
    yield* scripts.served.pipe(
      Stream.runForEach((served) => tellLead(served.threadId, servedNote(served), { wakes: false })),
      Effect.forkIn(layerScope),
    );
  });

  /**
   * Removes a thread's worktree once its sessions have ended: a harness still running in the folder
   * would hold it open. Refused while the worktree holds work its base doesn't, unless the user
   * chose to discard it.
   */
  const removeWorktree = Effect.fn("Orchestrator.removeWorktree")(function* (
    threadId: ThreadId,
    worktree: ThreadWorktree,
    cwd: string,
    options: PutAwayOptions,
  ) {
    // A checkout still under way finishes first, or git is left with half a worktree.
    const making = checkouts.get(threadId);
    if (making !== undefined) yield* Effect.exit(Deferred.await(making));
    if (options.discardWork !== true) {
      const changes = yield* worktrees.changes(worktree).pipe(Effect.mapError(refusedWorktree));
      if (changes.uncommitted > 0 || changes.unmerged > 0) {
        return yield* notAllowed(
          `This thread's worktree has ${describeChanges(changes, worktree.base)}; confirm to put it away.`,
        );
      }
    }
    yield* stopThreadAgents(threadId);
    // The project's teardown runs in the worktree while it is still there, its agents ended; a
    // failing one is told to whoever put the thread away, and doesn't stop them.
    const torn = yield* scripts.teardown({ threadId, project: worktree.project, cwd });
    if (torn !== undefined) {
      yield* Effect.logWarning(`The teardown of ${worktree.branch} failed: ${torn.failure}`);
      options.onTeardownFailed?.(torn);
    }
    yield* worktrees.remove(threadId, worktree).pipe(Effect.mapError(refusedWorktree));
    threadWorktrees.delete(threadId);
  });

  /** Runs the project's setup in a worktree just checked out: it starts empty of what setup installs. */
  const setUp = (threadId: ThreadId, worktree: ThreadWorktree, cwd: string) =>
    scripts
      .start({ kind: "setup", threadId, project: worktree.project, cwd, auto: true })
      .pipe(Effect.option);

  /**
   * Checks a new thread's worktree out behind its lead, whose session waits for it, so the thread
   * shows at once; then setup runs there, and the lead hears with its first turn what runs and
   * what was copied in.
   */
  const makeWorktree = (threadId: ThreadId, leadId: AgentId, { worktree, cwd }: NewWorktree) =>
    Effect.gen(function* () {
      const copied = yield* worktrees.checkOut(worktree).pipe(
        // Stopping the lead meanwhile waits for it rather than leave git half a worktree.
        Effect.uninterruptible,
        Effect.mapError(
          (error) =>
            new OrchestratorError({
              reason: "unavailable",
              message: `Couldn't make the thread's worktree: ${error.message}`,
            }),
        ),
      );
      const started = yield* setUp(threadId, worktree, cwd);
      const notice: InputItem = {
        _tag: "SystemNotice",
        text:
          setupNote(Option.getOrUndefined(started)) +
          copiedNote(copied) +
          portsNote(yield* scripts.ports(threadId)),
      };
      holdNotice(leadId, notice);
    });

  /**
   * Puts back a thread's worktree whose folder is gone (Cerium quit while making it, or the user
   * deleted it), or is only what's left of a removal still deleting it, without its `.git` file.
   */
  const ensureWorktree = (threadId: ThreadId, worktree: ThreadWorktree, cwd: string) =>
    Effect.gen(function* () {
      const marker = path.join(worktree.root, ".git");
      if (yield* fs.exists(marker).pipe(Effect.orElseSucceed(() => true))) return;
      yield* worktrees.restore(worktree).pipe(Effect.mapError(refusedWorktree));
      yield* setUp(threadId, worktree, cwd);
    });

  return {
    forwardScriptNews,
    removeWorktree,
    setUp,
    makeWorktree,
    ensureWorktree,
  };
};

export type ThreadWorkspace = ReturnType<typeof makeThreadWorkspace>;
