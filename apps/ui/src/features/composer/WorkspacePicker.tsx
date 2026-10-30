import { Popover } from "@base-ui/react/popover";
import { Button } from "@base-ui/react/button";
import type { WorkspaceChoice } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { checkoutsAtom } from "../../backend/projects.ts";
import { chipClass } from "./Pickers.tsx";
import { Select } from "@base-ui/react/select";
import { SelectRoot, SelectPopup, SelectItem } from "../../components/ui/Select.tsx";

const field =
  "w-full rounded-md border border-line-subtle bg-surface-window px-2.5 py-2 text-meta text-fg-primary outline-none focus:border-line-strong";
const row =
  "w-full rounded-lg px-3 py-2 text-left text-meta text-fg-primary hover:bg-surface-hover focus-visible:bg-surface-hover outline-none";

export function WorkspacePicker({
  branch,
  root,
  value,
  workspace,
  onPick,
}: {
  readonly branch: string;
  readonly root: string;
  readonly value: boolean;
  readonly workspace?: WorkspaceChoice | undefined;
  readonly onPick: (worktree: boolean, workspace?: WorkspaceChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [baseRef, setBaseRef] = useState(workspace?.baseRef ?? branch);
  const [name, setName] = useState(workspace?.branch ?? "");
  const [existingBranch, setExistingBranch] = useState(workspace?.existingBranch ?? "");
  const [pullRequestUrl, setPullRequestUrl] = useState(workspace?.pullRequestUrl ?? "");
  const [sourceThreadId, setSourceThreadId] = useState(workspace?.sourceThreadId ?? "");
  const result = useAtomValue(checkoutsAtom(root));
  const refresh = useAtomRefresh(checkoutsAtom(root));
  const checkouts = AsyncResult.getOrElse(result, () => []);
  const picked = checkouts.find((checkout) => checkout.path === workspace?.path);
  const select = (worktree: boolean, choice?: WorkspaceChoice) => {
    onPick(worktree, choice);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh();
      }}
    >
      <Popover.Trigger
        aria-label="Where agents work"
        className={`${chipClass.replace("shrink-0 ", "")} min-w-8 shrink-[4] px-2`}
      >
        <GitBranch size={13} />
        <span className="max-w-36 truncate">{picked?.branch || (value ? "New workspace" : branch)}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="max-h-[min(80vh,640px)] w-96 max-w-[calc(100vw-24px)] overflow-auto rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl outline-none">
            <div className="px-4 pt-3 pb-2">
              <Popover.Title className="text-body font-medium">Where agents work</Popover.Title>
              <Popover.Description className="mt-1 text-meta text-fg-secondary">
                Reuse a checkout for related conversations, or isolate a new task.
              </Popover.Description>
            </div>
            <div className="px-1.5 pb-1.5">
              <Button className={row} onClick={() => select(false)}>
                <span className="block font-medium">Current checkout</span>
                <span className="text-fg-secondary">{branch}</span>
              </Button>
              <Button className={row} onClick={() => setCreating(!creating)}>
                <span className="block font-medium">New workspace</span>
                <span className="text-fg-secondary">Choose a base and a branch of its own</span>
              </Button>
            </div>
            {creating ? (
              <form
                className="space-y-3 border-t border-line-subtle p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (baseRef.trim())
                    select(true, {
                      baseRef: baseRef.trim(),
                      ...(name.trim() ? { branch: name.trim() } : {}),
                      ...(existingBranch.trim() ? { existingBranch: existingBranch.trim() } : {}),
                      ...(pullRequestUrl.trim() ? { pullRequestUrl: pullRequestUrl.trim() } : {}),
                      ...(sourceThreadId ? { sourceThreadId } : {}),
                    });
                }}
              >
                <label className="block space-y-1 text-meta text-fg-secondary">
                  <span>Base branch or commit</span>
                  <input
                    className={field}
                    value={baseRef}
                    onChange={(event) => setBaseRef(event.target.value)}
                    required
                  />
                </label>
                <label className="block space-y-1 text-meta text-fg-secondary">
                  <span>New branch name</span>
                  <input
                    className={field}
                    placeholder="Name from the task"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="block space-y-1 text-meta text-fg-secondary">
                  <span>Or use an existing branch</span>
                  <input
                    className={field}
                    placeholder="Existing local branch"
                    value={existingBranch}
                    onChange={(event) => setExistingBranch(event.target.value)}
                  />
                </label>
                <label className="block space-y-1 text-meta text-fg-secondary">
                  <span>Start from a pull request</span>
                  <input
                    type="url"
                    className={field}
                    placeholder="Optional GitHub PR URL"
                    value={pullRequestUrl}
                    onChange={(event) => setPullRequestUrl(event.target.value)}
                  />
                </label>
                {checkouts.some((checkout) => checkout.threads.length) ? (
                  <div className="space-y-1 text-meta text-fg-secondary">
                    <span>Build on a conversation</span>
                    <SelectRoot
                      value={sourceThreadId}
                      onValueChange={(id: string | null) => {
                        setSourceThreadId(id ?? "");
                        const parent = checkouts.find((checkout) =>
                          checkout.threads.some((thread) => thread.id === id),
                        );
                        if (parent) setBaseRef(parent.branch);
                      }}
                    >
                      <Select.Trigger className={`${field} text-left`} aria-label="Build on a conversation">
                        <Select.Value>
                          {checkouts
                            .flatMap((checkout) => checkout.threads)
                            .find((thread) => thread.id === sourceThreadId)?.title ?? "Independent task"}
                        </Select.Value>
                      </Select.Trigger>
                      <SelectPopup>
                        <SelectItem value="">Independent task</SelectItem>
                        {checkouts.flatMap((checkout) =>
                          checkout.threads.map((thread) => (
                            <SelectItem key={thread.id} value={thread.id}>
                              {thread.title}
                            </SelectItem>
                          )),
                        )}
                      </SelectPopup>
                    </SelectRoot>
                  </div>
                ) : null}
                <Button
                  type="submit"
                  className={`${row} bg-surface-active text-center`}
                  disabled={!baseRef.trim()}
                >
                  Use new workspace
                </Button>
              </form>
            ) : (
              <div className="border-t border-line-subtle">
                <div className="p-3">
                  <input
                    aria-label="Find a workspace"
                    className={field}
                    placeholder="Find a branch or path…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <div className="max-h-60 overflow-auto px-1.5 pb-2">
                  {AsyncResult.isFailure(result) ? (
                    <Button className={row} onClick={refresh}>
                      Couldn't load workspaces. Retry
                    </Button>
                  ) : null}
                  {AsyncResult.isInitial(result) ? (
                    <p className="px-3 py-2 text-meta text-fg-secondary">Finding checkouts…</p>
                  ) : null}
                  {checkouts
                    .filter(
                      (checkout) =>
                        !checkout.detached &&
                        `${checkout.branch} ${checkout.path}`.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((checkout) => (
                      <Button
                        key={checkout.id}
                        className={row}
                        onClick={() => select(false, { path: checkout.path })}
                      >
                        <span className="block truncate font-medium">{checkout.branch}</span>
                        <span className="block truncate text-caption text-fg-secondary">{checkout.path}</span>
                        {checkout.threads.length > 0 ? (
                          <span className="block text-caption text-fg-secondary">
                            {checkout.threads.length} linked conversations ·{" "}
                            {checkout.threads.filter((thread) => thread.active).length} active
                          </span>
                        ) : null}
                      </Button>
                    ))}
                  {AsyncResult.isSuccess(result) && checkouts.length === 0 ? (
                    <p className="px-3 py-2 text-meta text-fg-secondary">No existing workspaces.</p>
                  ) : null}
                </div>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
