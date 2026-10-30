import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { WorkspaceChoice } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { checkoutsAtom } from "../../backend/projects.ts";
import { DialogButton, DialogField, DialogInput, DialogSelect } from "../../components/ui/FormDialog.tsx";
import {
  checkoutDetail,
  checkoutsMatching,
  linkKindOf,
  samePath,
  worktreeChoice,
  worktreeForm,
  type WorktreeForm,
  type WorktreeSource,
} from "./workspace.ts";

// Where a thread works, chosen in one list: the project's own folder, a checkout another thread
// already works in, or a new worktree, whose form opens in the list's place. The message box asks it
// of a new thread, and the workspace's menu of a thread that moves.

/** What the chooser picked: a worktree of its own, or a checkout as it is. */
export interface CheckoutPick {
  readonly worktree: boolean;
  readonly workspace?: WorkspaceChoice | undefined;
}

const rowClass =
  "grid w-full cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-left text-fg-secondary outline-none select-none hover:bg-surface-hover hover:text-fg-primary focus-visible:bg-surface-hover focus-visible:text-fg-primary data-disabled:opacity-40 max-md:py-2.5";

/** One place in the list: its icon, its branch, and where it is underneath. */
export function ChooserRow({
  icon: Icon,
  title,
  detail,
  path,
  selected = false,
  trailing,
  onClick,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
  /** The folder in full, on hover. */
  path?: string | undefined;
  selected?: boolean;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button className={rowClass} onClick={onClick} aria-pressed={selected} {...(path ? { title: path } : {})}>
      <Icon
        size={14}
        strokeWidth={1.75}
        className={`text-fg-tertiary ${detail ? "self-start mt-[3px]" : ""}`}
      />
      <span className="flex min-w-0 flex-col">
        <span className={`truncate text-body ${selected ? "text-fg-primary" : ""}`}>{title}</span>
        {detail ? <span className="truncate text-caption text-fg-tertiary">{detail}</span> : null}
      </span>
      {selected ? <Check size={13} strokeWidth={2.25} className="text-fg-primary" /> : (trailing ?? <span />)}
    </Button>
  );
}

/** A view's head inside a popover: back, its title, and room for an action. */
export function ViewHeader({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack?: (() => void) | undefined;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle px-1.5">
      {onBack ? (
        <Button
          aria-label="Back"
          onClick={onBack}
          className="grid size-7 place-items-center rounded-md text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          <ChevronLeft size={15} strokeWidth={1.75} />
        </Button>
      ) : null}
      <span
        className={`min-w-0 flex-1 truncate text-body font-medium text-fg-primary ${onBack ? "" : "pl-1.5"}`}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

export function CheckoutChooser({
  root,
  branch,
  local,
  except = [],
  selectedPath,
  worktree,
  title,
  hint,
  onBack,
  confirmLabel,
  onPick,
}: {
  /** The project's folder, whose repository's checkouts are listed. */
  root: string;
  /** The branch checked out there: a new worktree starts from it unless told otherwise. */
  branch: string;
  /** The project's own folder as a choice of its own, and whether it's the one picked. */
  local?: { readonly selected: boolean } | undefined;
  /** Checkouts left out of the list: the project's folder when `local` stands for it, the one a thread leaves. */
  except?: ReadonlyArray<string>;
  /** The checkout picked already, ticked in the list. */
  selectedPath?: string | undefined;
  /** Whether a new worktree is the one picked, and what was asked of it. */
  worktree?: { readonly selected: boolean; readonly choice?: WorkspaceChoice | undefined } | undefined;
  /** Heads the list, with back beside it, where the chooser is one view of several. */
  title?: string | undefined;
  /** A line under the title on what picking does. */
  hint?: string | undefined;
  onBack?: (() => void) | undefined;
  /** The new worktree form's button. */
  confirmLabel: string;
  onPick: (pick: CheckoutPick) => void;
}) {
  const [view, setView] = useState<"list" | "new">("list");
  const [query, setQuery] = useState("");
  const result = useAtomValue(checkoutsAtom(root));
  const refresh = useAtomRefresh(checkoutsAtom(root));
  const checkouts = AsyncResult.getOrElse(result, () => []);
  const listed = checkoutsMatching(checkouts, query, except);
  const sources = checkouts.flatMap((checkout) =>
    checkout.detached
      ? []
      : checkout.threads
          .filter((thread) => thread.active)
          .map((thread) => ({ id: thread.id, title: thread.title, branch: checkout.branch })),
  );

  if (view === "new")
    return (
      <NewWorktree
        initial={worktreeForm(worktree?.choice, branch)}
        sources={sources}
        confirmLabel={confirmLabel}
        onBack={() => setView("list")}
        onDone={(choice) => onPick({ worktree: true, workspace: choice })}
      />
    );

  return (
    <div className="flex min-h-0 flex-col">
      {title ? <ViewHeader title={title} onBack={onBack} /> : null}
      {hint ? (
        <p className="shrink-0 border-b border-line-subtle px-3 py-2 text-meta text-fg-tertiary">{hint}</p>
      ) : null}
      <label className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3 text-fg-tertiary">
        <Search size={13} strokeWidth={1.75} className="shrink-0" />
        <input
          aria-label="Find a checkout"
          placeholder="Find a branch or folder"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent text-body text-fg-primary outline-none placeholder:text-fg-tertiary"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {local && query.trim() === "" ? (
          <ChooserRow
            icon={FolderGit2}
            title="Project folder"
            detail={branch ? `On ${branch}` : undefined}
            path={root}
            selected={local.selected}
            onClick={() => onPick({ worktree: false })}
          />
        ) : null}
        {query.trim() === "" ? (
          <ChooserRow
            icon={GitBranchPlus}
            title="New worktree"
            detail="A branch and folder of its own"
            selected={worktree?.selected ?? false}
            trailing={<ChevronRight size={13} strokeWidth={1.75} className="text-fg-tertiary" />}
            onClick={() => setView("new")}
          />
        ) : null}
        {listed.length > 0 || AsyncResult.isFailure(result) ? (
          <div className="px-2 pt-2.5 pb-1 text-caption font-medium text-fg-tertiary select-none">
            Checkouts
          </div>
        ) : null}
        {listed.map((checkout) => {
          return (
            <ChooserRow
              key={checkout.id}
              icon={GitBranch}
              title={checkout.branch}
              detail={checkoutDetail(checkout)}
              path={checkout.path}
              selected={selectedPath !== undefined && samePath(selectedPath, checkout.path)}
              onClick={() => onPick({ worktree: false, workspace: { path: checkout.path } })}
            />
          );
        })}
        {AsyncResult.isFailure(result) ? (
          <p className="flex items-center justify-between gap-2 px-2 py-1.5 text-meta text-fg-tertiary">
            Couldn't list the checkouts.
            <Button
              onClick={refresh}
              className="rounded-md px-1.5 py-0.5 text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
            >
              Retry
            </Button>
          </p>
        ) : null}
        {query.trim() !== "" && listed.length === 0 && AsyncResult.isSuccess(result) ? (
          <p className="px-2 py-3 text-center text-meta text-fg-tertiary">No checkout matches.</p>
        ) : null}
      </div>
    </div>
  );
}

const sourceLabel: Record<WorktreeSource, string> = {
  base: "Branch",
  thread: "Thread",
  pull: "Pull request",
  existing: "Existing",
};

const toggleClass =
  "h-6 flex-1 rounded-md px-2 text-meta font-medium whitespace-nowrap text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:h-8 max-md:text-[13px]";

/** A new worktree's form: where it starts, then its branch's name. */
function NewWorktree({
  initial,
  sources,
  confirmLabel,
  onBack,
  onDone,
}: {
  initial: WorktreeForm;
  /** The active threads it can build on, each with the branch it's on. */
  sources: ReadonlyArray<{ readonly id: string; readonly title: string; readonly branch: string }>;
  confirmLabel: string;
  onBack: () => void;
  onDone: (choice: WorkspaceChoice) => void;
}) {
  const [form, setForm] = useState(initial);
  const set = (patch: Partial<WorktreeForm>) => setForm((current) => ({ ...current, ...patch }));
  const choice = worktreeChoice(form);
  const offered = (Object.keys(sourceLabel) as ReadonlyArray<WorktreeSource>).filter(
    (source) => source !== "thread" || sources.length > 0,
  );
  const badPull = form.source === "pull" && form.pullUrl.trim() !== "" && linkKindOf(form.pullUrl) !== "pull";

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice) onDone(choice);
      }}
    >
      <ViewHeader title="New worktree" onBack={onBack} />
      <div className="flex flex-col gap-3.5 p-3">
        <ToggleGroup
          aria-label="Start from"
          value={[form.source]}
          onValueChange={(value) => {
            const next = value[0] as WorktreeSource | undefined;
            if (next) set({ source: next });
          }}
          className="flex gap-0.5 rounded-lg bg-surface-sunken p-0.5"
        >
          {offered.map((source) => (
            <Toggle key={source} value={source} className={toggleClass}>
              {sourceLabel[source]}
            </Toggle>
          ))}
        </ToggleGroup>
        {form.source === "base" ? (
          <DialogField label="From">
            <DialogInput
              value={form.base}
              placeholder="A branch, tag or commit"
              onChange={(event) => set({ base: event.target.value })}
            />
          </DialogField>
        ) : form.source === "thread" ? (
          <DialogField label="Builds on">
            <DialogSelect
              value={form.thread?.id ?? ""}
              onChange={(event) => {
                const picked = sources.find((source) => source.id === event.target.value);
                set({ thread: picked ? { id: picked.id, branch: picked.branch } : undefined });
              }}
            >
              <option value="" disabled>
                Choose a thread
              </option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title}
                </option>
              ))}
            </DialogSelect>
          </DialogField>
        ) : form.source === "pull" ? (
          <DialogField label="Pull request">
            <DialogInput
              type="url"
              value={form.pullUrl}
              placeholder="https://github.com/owner/repo/pull/1"
              onChange={(event) => set({ pullUrl: event.target.value })}
            />
          </DialogField>
        ) : (
          <DialogField label="Branch">
            <DialogInput
              value={form.existing}
              placeholder="A local branch no checkout is on"
              onChange={(event) => set({ existing: event.target.value })}
            />
          </DialogField>
        )}
        {form.source === "existing" ? null : (
          <DialogField label="New branch">
            <DialogInput
              value={form.branch}
              placeholder="Named from the task"
              onChange={(event) => set({ branch: event.target.value })}
            />
          </DialogField>
        )}
        {badPull ? (
          <p className="-mt-1.5 text-meta text-error-text">That isn't a pull request's address.</p>
        ) : null}
      </div>
      <div className="flex justify-end border-t border-line-subtle px-3 py-2.5">
        <DialogButton type="submit" tone="primary" disabled={choice === undefined}>
          {confirmLabel}
        </DialogButton>
      </div>
    </form>
  );
}
