import { Popover } from "@base-ui/react/popover";
import { Button } from "@base-ui/react/button";
import type { CheckoutInfo, SourceControlCommand, ThreadId } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { sourceControl, workspaceAtom } from "../../backend/sourceControl.ts";
import { useKeptHidden } from "../../components/KeptViews.tsx";
import { SelectItem, SelectPopup, SelectRoot } from "../../components/ui/Select.tsx";
import { Select } from "@base-ui/react/select";
import { WorkspacePicker } from "../composer/WorkspacePicker.tsx";

const actionClass =
  "rounded-md px-2 py-1.5 text-meta text-fg-secondary hover:bg-surface-hover hover:text-fg-primary disabled:opacity-50";
const inputClass =
  "min-w-0 flex-1 rounded-md border border-line-subtle bg-surface-window px-2 py-1.5 text-meta text-fg-primary outline-none focus:border-line-strong";

export function WorkspaceSummary({
  threadId,
  projectRoot,
  onOpenSourceControl,
  onOpenThread,
}: {
  readonly threadId: ThreadId;
  readonly projectRoot: string;
  readonly onOpenSourceControl: () => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const result = useAtomValue(workspaceAtom(threadId));
  const refresh = useAtomRefresh(workspaceAtom(threadId));
  const run = useAtomSet(sourceControl, { mode: "promise" });
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState<"turn" | "thread" | "uncommitted" | "branch">("branch");
  const [diff, setDiff] = useState<string>();
  const [revision, setRevision] = useState("");
  const [note, setNote] = useState("");
  const [checkouts, setCheckouts] = useState<ReadonlyArray<CheckoutInfo>>();
  const [busy, setBusy] = useState(false);
  const hidden = useKeptHidden();
  const state = AsyncResult.getOrElse(result, () => undefined)?.snapshot;
  useEffect(() => {
    if (hidden) return;
    const timer = setInterval(refresh, open ? 10000 : 30000);
    return () => clearInterval(timer);
  }, [hidden, open, refresh]);
  const execute = async (command: SourceControlCommand) => {
    if (busy) return;
    setBusy(true);
    setNote("");
    try {
      const answer = await run({ payload: { threadId, command } });
      setNote(answer.note);
      if (answer.checkouts) setCheckouts(answer.checkouts);
      if (command.action === "cleanup")
        setCheckouts((current) => current?.filter((checkout) => checkout.path !== command.targetPath));
      if (answer.diff !== undefined) {
        setDiff(answer.diff);
        setRevision(answer.revision ?? "");
      }
      refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!state)
    return AsyncResult.isFailure(result) ? (
      <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-1 text-caption text-fg-secondary">
        <Button className={actionClass} onClick={refresh}>
          Workspace unavailable · Retry
        </Button>
        <WorkspacePicker
          branch="Choose another checkout"
          root={projectRoot}
          value={false}
          onPick={(isolated, choice) =>
            void execute({ action: "move", workspace: choice ?? (isolated ? {} : { path: projectRoot }) })
          }
        />
        {note ? <output>{note}</output> : null}
      </div>
    ) : null;
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-3 py-1 text-meta text-fg-secondary">
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) refresh();
        }}
      >
        <Popover.Trigger
          className={`${actionClass} flex min-w-0 items-center gap-2`}
          aria-label="Workspace details"
        >
          <GitBranch size={13} />
          <span className="max-w-52 truncate font-medium text-fg-primary">{state.branch}</span>
          <span>{state.staged + state.unstaged} changed</span>
          {state.ahead > 0 ? <span>↑{state.ahead}</span> : null}
          {state.behind > 0 ? <span>↓{state.behind}</span> : null}
          {state.pulls.some((pull) => pull.checks === "failed") ? (
            <span className="text-attention-text">Checks failing</span>
          ) : null}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
            <Popover.Popup className="max-h-[min(80vh,720px)] w-[32rem] max-w-[calc(100vw-24px)] overflow-auto rounded-xl border border-line-subtle bg-surface-overlay p-4 text-fg-primary shadow-overlay backdrop-blur-2xl outline-none">
              <div className="flex items-center justify-between gap-3">
                <Popover.Title className="text-body font-medium">Workspace</Popover.Title>
                <Button className={actionClass} onClick={refresh} aria-label="Refresh workspace">
                  <RefreshCw size={14} />
                </Button>
              </div>
              <Popover.Description className="mt-1 truncate text-meta text-fg-secondary" title={state.root}>
                {state.root}
              </Popover.Description>
              <p className="mt-2 text-caption text-fg-secondary">
                {state.branch} at {state.head.slice(0, 8)} · Base {state.baseRef}
              </p>
              {state.baseMoved ? (
                <p className="mt-2 text-meta text-attention-text">
                  The base moved since this workspace started. Review incoming changes before updating it.
                </p>
              ) : null}
              {state.dependsOnThreadId ? (
                <Button
                  className={`${actionClass} mt-1`}
                  onClick={() => onOpenThread(state.dependsOnThreadId!)}
                >
                  Open the thread this work builds on
                </Button>
              ) : null}
              <div className="mt-3 border-t border-line-subtle pt-3">
                <p className="text-meta font-medium">Related conversations</p>
                {state.threads.map((thread) => (
                  <Button
                    key={thread.id}
                    className={`${actionClass} block w-full truncate text-left`}
                    onClick={() => onOpenThread(thread.id)}
                  >
                    {thread.title}
                    {thread.id === threadId ? " · This conversation" : thread.active ? "" : " · Archived"}
                  </Button>
                ))}
              </div>
              <div className="mt-3 border-t border-line-subtle pt-3">
                <p className="text-meta font-medium">Pull requests</p>
                {state.pulls.length === 0 ? (
                  <p className="mt-1 text-meta text-fg-secondary">
                    Link a PR to keep checks and review feedback with this work.
                  </p>
                ) : null}
                {state.pulls.map((pull) => (
                  <div key={pull.url} className="mt-2 text-meta">
                    <a
                      className="font-medium underline decoration-line-subtle underline-offset-2"
                      href={pull.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {pull.title}
                    </a>
                    <p className="text-caption text-fg-secondary">
                      {pull.state.toLowerCase()} · Checks {pull.checks} · Review {pull.review}
                    </p>
                    <Button
                      disabled={busy}
                      className={actionClass}
                      onClick={() =>
                        void execute({ action: pull.watching ? "unwatch" : "watch", url: pull.url })
                      }
                    >
                      {pull.watching ? "Stop watching" : "Watch PR"}
                    </Button>
                    <Button
                      disabled={busy}
                      className={actionClass}
                      onClick={() => void execute({ action: "unlink", url: pull.url })}
                    >
                      Unlink from this thread
                    </Button>
                  </div>
                ))}
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void execute({ action: "link", url });
                  }}
                >
                  <input
                    type="url"
                    aria-label="Pull request URL"
                    placeholder="Paste a pull request URL"
                    className={inputClass}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    required
                  />
                  <Button type="submit" className={actionClass} disabled={busy || !url}>
                    Link PR
                  </Button>
                </form>
                <div className="mt-2">
                  <Button
                    className={actionClass}
                    disabled={busy || !url}
                    onClick={() => void execute({ action: "link_issue", url })}
                  >
                    Link this URL as an issue
                  </Button>
                </div>
                {state.issues.map((issue) => (
                  <div key={issue.url} className="mt-2 text-meta">
                    <a
                      className="underline underline-offset-2"
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {issue.title}
                    </a>
                    <span className="ml-2 text-caption text-fg-secondary">{issue.state.toLowerCase()}</span>
                    <Button
                      className={actionClass}
                      disabled={busy}
                      onClick={() => void execute({ action: "unlink_issue", url: issue.url })}
                    >
                      Unlink issue
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-3 border-t border-line-subtle pt-3">
                <p className="text-meta font-medium">Review changes</p>
                <div className="mt-2 flex items-center gap-2">
                  <SelectRoot
                    value={scope}
                    onValueChange={(value: string | null) => {
                      if (value) setScope(value as typeof scope);
                    }}
                  >
                    <Select.Trigger className={`${inputClass} text-left`} aria-label="Review scope">
                      <Select.Value>
                        {scope === "branch"
                          ? "Branch against base"
                          : scope === "uncommitted"
                            ? "Uncommitted changes"
                            : scope === "turn"
                              ? "This turn"
                              : "This thread"}
                      </Select.Value>
                    </Select.Trigger>
                    <SelectPopup>
                      <SelectItem value="turn">This turn</SelectItem>
                      <SelectItem value="thread">This thread</SelectItem>
                      <SelectItem value="uncommitted">Uncommitted changes</SelectItem>
                      <SelectItem value="branch">Branch against base</SelectItem>
                    </SelectPopup>
                  </SelectRoot>
                  <Button
                    className={actionClass}
                    disabled={busy}
                    onClick={() => void execute({ action: "diff", scope })}
                  >
                    Read diff
                  </Button>
                </div>
                {diff !== undefined ? (
                  <div className="mt-2">
                    <p className="text-caption text-fg-secondary">
                      Reviewed at {revision.slice(0, 8)}
                      {state.head !== revision ? " · HEAD changed; refresh the review" : ""}
                    </p>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-surface-window p-3 text-caption">
                      {diff || "No recorded changes in this scope."}
                    </pre>
                  </div>
                ) : null}
              </div>
              <div className="mt-3 border-t border-line-subtle pt-3">
                <p className="text-meta font-medium">Move this conversation</p>
                <p className="mt-1 text-caption text-fg-secondary">
                  Committed files follow the selected base. Uncommitted edits stay in the source checkout. The
                  move waits for the current turn to finish.
                </p>
                <div className="mt-2">
                  <WorkspacePicker
                    branch={state.branch}
                    root={state.root}
                    value={false}
                    onPick={(isolated, choice) =>
                      void execute({
                        action: "move",
                        workspace: choice ?? (isolated ? {} : { path: state.root }),
                      })
                    }
                  />
                </div>
              </div>
              <div className="mt-3 border-t border-line-subtle pt-3">
                <p className="text-meta text-fg-secondary">{state.preparation}</p>
                <Button
                  className={actionClass}
                  disabled={busy}
                  onClick={() => void execute({ action: "list" })}
                >
                  Manage checkouts
                </Button>
                {checkouts?.map((checkout) => (
                  <div key={checkout.id} className="mt-2 text-meta">
                    <span className="block truncate font-medium">
                      {checkout.branch || "Detached checkout"}
                    </span>
                    <span className="block truncate text-caption text-fg-secondary" title={checkout.path}>
                      {checkout.path}
                    </span>
                    <span className="text-caption text-fg-secondary">
                      {checkout.threads.filter((thread) => thread.active).length} active conversations
                    </span>
                    {checkout.managed && checkout.threads.every((thread) => !thread.active) ? (
                      <Button
                        className={actionClass}
                        disabled={busy}
                        onClick={() => void execute({ action: "cleanup", targetPath: checkout.path })}
                      >
                        Remove clean workspace
                      </Button>
                    ) : null}
                  </div>
                ))}
                <Button
                  className={actionClass}
                  disabled={busy}
                  onClick={() => void execute({ action: "retry_setup" })}
                >
                  Retry setup
                </Button>
                {state.threads.every((thread) => !thread.active) ? (
                  <Button
                    className={actionClass}
                    disabled={busy}
                    onClick={() => void execute({ action: "cleanup", targetPath: state.root })}
                  >
                    Remove clean workspace
                  </Button>
                ) : (
                  <p className="mt-1 text-caption text-fg-secondary">
                    Archiving keeps the checkout. Workspace cleanup is available after all linked
                    conversations are archived; local files and unmerged work prevent removal.
                  </p>
                )}
              </div>
              {note ? <output className="mt-3 block text-meta text-fg-secondary">{note}</output> : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <Button className={`${actionClass} ml-auto whitespace-nowrap`} onClick={onOpenSourceControl}>
        {state.nextAction}
      </Button>
    </div>
  );
}
