import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { CheckoutInfo, SourceControlCommand, SourceControlSnapshot, ThreadId } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Bell,
  BellRing,
  CircleAlert,
  CircleDot,
  CircleX,
  CornerDownRight,
  Ellipsis,
  FolderGit2,
  GitBranch,
  Link2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { sourceControl, workspaceAtom } from "../../backend/sourceControl.ts";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { DialogButton } from "../../components/ui/FormDialog.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { PullStateIcon } from "../github/parts.tsx";
import { CheckoutChooser, ChooserRow, ViewHeader } from "./CheckoutChooser.tsx";
import {
  linkKindOf,
  linkNumber,
  pathTail,
  pullFacts,
  pullStateKind,
  samePath,
  statusWords,
  checkoutDetail,
} from "./workspace.ts";

// The open thread's workspace, in the titlebar: its branch and what waits there at a glance, and on
// click everything Cerium keeps with it: the threads that share it, the pull requests and issues
// linked to it, a review of its changes, and moving the thread or clearing checkouts away.

type Scope = "turn" | "thread" | "uncommitted" | "branch";
type View = "overview" | "move" | "checkouts";

const scopes: ReadonlyArray<{ readonly value: Scope; readonly label: string }> = [
  { value: "turn", label: "Last turn" },
  { value: "thread", label: "Thread" },
  { value: "uncommitted", label: "Uncommitted" },
  { value: "branch", label: "Branch" },
];

const toggleClass =
  "h-6 flex-1 rounded-md px-2 text-meta font-medium whitespace-nowrap text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary";

const popupClass =
  "flex max-h-[min(var(--available-height),40rem)] w-[26rem] max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0";

/** The longest review the popover draws; the source control panel has the rest. */
const DIFF_LINES = 1500;

export function WorkspaceStatus({
  threadId,
  projectRoot,
  onOpenSourceControl,
  onOpenThread,
}: {
  readonly threadId: ThreadId;
  /** The project's folder, whose checkouts a thread can move to. */
  readonly projectRoot: string;
  readonly onOpenSourceControl: () => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const result = useAtomValue(workspaceAtom(threadId));
  const refresh = useAtomRefresh(workspaceAtom(threadId));
  const run = useAtomSet(sourceControl, { mode: "promise" });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly text: string; readonly error: boolean }>();
  const [checkouts, setCheckouts] = useState<ReadonlyArray<CheckoutInfo>>();
  const [scope, setScope] = useState<Scope>("branch");
  const [diff, setDiff] = useState<{ readonly text: string; readonly revision: string }>();
  const [removing, setRemoving] = useState<string>();
  const state = AsyncResult.getOrElse(result, () => undefined)?.snapshot;

  // The checkout changes under the thread as its agents work: read it again now and then, more often while it's open.
  useEffect(() => {
    const timer = setInterval(refresh, open ? 10_000 : 30_000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const execute = async (command: SourceControlCommand) => {
    if (busy) return false;
    setBusy(true);
    setNote(undefined);
    try {
      const answer = await run({ payload: { threadId, command } });
      // A read shows its answer in place; only a change says how it went.
      if (answer.note && command.action !== "diff" && command.action !== "list")
        setNote({ text: answer.note, error: false });
      if (answer.checkouts) setCheckouts(answer.checkouts);
      if (command.action === "cleanup")
        setCheckouts((current) =>
          current?.filter((checkout) => !samePath(checkout.path, command.targetPath ?? "")),
        );
      if (answer.diff !== undefined) setDiff({ text: answer.diff, revision: answer.revision ?? "" });
      refresh();
      return true;
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : String(error), error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const showCheckouts = () => {
    setView("checkouts");
    void execute({ action: "list" });
  };

  if (state === undefined && !AsyncResult.isFailure(result)) return null;

  const changed = state ? state.staged + state.unstaged : 0;
  const failing = state?.pulls.some((pull) => pull.checks === "failed") ?? false;
  const words = state ? statusWords(state) : [];

  return (
    <>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) refresh();
          else {
            setView("overview");
            setNote(undefined);
          }
        }}
      >
        <Tooltip
          label={
            state
              ? ["Workspace", ...words, ...(failing ? ["checks fail"] : [])].join(" · ")
              : "Workspace unavailable"
          }
        >
          <Popover.Trigger
            aria-label="Workspace"
            className="mr-1 flex h-7 max-w-72 min-w-0 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary transition-colors [app-region:no-drag] hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-selected data-popup-open:text-fg-primary pointer-coarse:h-10 max-md:h-10"
          >
            <GitBranch size={13} strokeWidth={1.75} className="shrink-0" />
            {state ? (
              <>
                <span className="truncate">{state.branch}</span>
                <span className="flex shrink-0 items-center gap-1.5 text-fg-tertiary tabular-nums empty:hidden">
                  {state.conflicted > 0 ? (
                    <CircleAlert size={12} strokeWidth={2} className="text-error-text" />
                  ) : changed > 0 ? (
                    <span className="flex items-center gap-1">
                      <span aria-hidden className="size-1.5 rounded-full bg-attention" />
                      {changed}
                    </span>
                  ) : null}
                  {state.ahead > 0 ? (
                    <span className="flex items-center">
                      <ArrowUp size={11} strokeWidth={2} />
                      {state.ahead}
                    </span>
                  ) : null}
                  {state.behind > 0 ? (
                    <span className="flex items-center">
                      <ArrowDown size={11} strokeWidth={2} />
                      {state.behind}
                    </span>
                  ) : null}
                  {failing ? <CircleX size={12} strokeWidth={2} className="text-error-text" /> : null}
                </span>
              </>
            ) : (
              <span className="text-fg-tertiary">Workspace</span>
            )}
          </Popover.Trigger>
        </Tooltip>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
            <Popover.Popup className={popupClass}>
              {view === "move" ? (
                <CheckoutChooser
                  root={projectRoot}
                  branch={state?.branch ?? ""}
                  except={state ? [state.root] : []}
                  title="Move this thread"
                  hint="Its commits come along; uncommitted edits stay where they are. It moves once its turn ends."
                  onBack={() => setView("overview")}
                  confirmLabel="Move here"
                  onPick={(pick) =>
                    void execute({ action: "move", workspace: pick.workspace ?? {} }).then(
                      (moved) => moved && setView("overview"),
                    )
                  }
                />
              ) : view === "checkouts" ? (
                <Checkouts
                  checkouts={checkouts}
                  current={state?.root}
                  busy={busy}
                  onBack={() => setView("overview")}
                  onRemove={setRemoving}
                />
              ) : state ? (
                <Overview
                  state={state}
                  threadId={threadId}
                  busy={busy}
                  scope={scope}
                  diff={diff}
                  onScope={(next) => {
                    setScope(next);
                    if (diff) void execute({ action: "diff", scope: next });
                  }}
                  onDiff={() => void execute({ action: "diff", scope })}
                  onHideDiff={() => setDiff(undefined)}
                  onRefresh={refresh}
                  onExecute={(command) => void execute(command)}
                  onMove={() => setView("move")}
                  onCheckouts={showCheckouts}
                  onRemove={() => setRemoving(state.root)}
                  onOpenThread={(id) => {
                    setOpen(false);
                    onOpenThread(id);
                  }}
                  onOpenSourceControl={() => {
                    setOpen(false);
                    onOpenSourceControl();
                  }}
                />
              ) : (
                <Unavailable onRetry={refresh} onMove={() => setView("move")} />
              )}
              {note ? (
                <output
                  className={`block shrink-0 border-t border-line-subtle px-3 py-2 text-meta ${
                    note.error ? "text-error-text" : "text-fg-secondary"
                  }`}
                >
                  {note.text}
                </output>
              ) : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(next) => {
          if (!next) setRemoving(undefined);
        }}
        title="Remove this workspace?"
        description={`Its folder, ${pathTail(removing ?? "")}, goes; its branch and commits stay. Cerium refuses while it holds uncommitted or unmerged work.`}
        confirmLabel="Remove"
        onConfirm={() => {
          const target = removing;
          setRemoving(undefined);
          if (target) void execute({ action: "cleanup", targetPath: target });
        }}
      />
    </>
  );
}

function Overview({
  state,
  threadId,
  busy,
  scope,
  diff,
  onScope,
  onDiff,
  onHideDiff,
  onRefresh,
  onExecute,
  onMove,
  onCheckouts,
  onRemove,
  onOpenThread,
  onOpenSourceControl,
}: {
  state: SourceControlSnapshot;
  threadId: ThreadId;
  busy: boolean;
  scope: Scope;
  diff: { readonly text: string; readonly revision: string } | undefined;
  onScope: (scope: Scope) => void;
  onDiff: () => void;
  onHideDiff: () => void;
  onRefresh: () => void;
  onExecute: (command: SourceControlCommand) => void;
  onMove: () => void;
  onCheckouts: () => void;
  onRemove: () => void;
  onOpenThread: (id: string) => void;
  onOpenSourceControl: () => void;
}) {
  const words = statusWords(state);
  const removable = state.threads.every((thread) => !thread.active);
  const setupFailed = state.preparation.startsWith("Setup failed");
  const others = state.threads.filter((thread) => thread.id !== threadId);
  const source = state.dependsOnThreadId;

  return (
    <div className="min-h-0 overflow-y-auto overscroll-contain">
      <header className="px-3 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <GitBranch size={15} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          <Popover.Title className="min-w-0 flex-1 truncate text-reading font-medium">
            {state.branch}
          </Popover.Title>
          <div className="-mr-1.5 flex shrink-0 items-center">
            <IconButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
            <MenuRoot>
              <MenuTrigger>
                <Button
                  aria-label="Workspace actions"
                  className="grid size-7 place-items-center rounded-md text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-hover data-popup-open:text-fg-primary"
                >
                  <Ellipsis size={15} strokeWidth={1.75} />
                </Button>
              </MenuTrigger>
              <MenuPopup>
                <MenuItem icon={ArrowRightLeft} onClick={onMove} disabled={busy}>
                  Move this thread…
                </MenuItem>
                <MenuItem icon={FolderGit2} onClick={onCheckouts}>
                  Checkouts…
                </MenuItem>
                <MenuItem
                  icon={RotateCcw}
                  onClick={() => onExecute({ action: "retry_setup" })}
                  disabled={busy}
                >
                  Run setup again
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} tone="danger" onClick={onRemove} disabled={busy || !removable}>
                  {removable ? "Remove workspace…" : "Remove once its threads are archived"}
                </MenuItem>
              </MenuPopup>
            </MenuRoot>
          </div>
        </div>
        <Popover.Description
          title={state.root}
          className="mt-0.5 truncate pl-[23px] text-meta text-fg-tertiary"
        >
          from <span className="text-fg-secondary">{state.baseRef}</span> ·{" "}
          <span className="font-mono">{state.head.slice(0, 7)}</span> · {pathTail(state.root)}
        </Popover.Description>
        <div className="mt-3 flex items-center gap-3 pl-[23px]">
          <span className="min-w-0 flex-1 truncate text-meta text-fg-secondary">
            {words.length > 0 ? words.join(" · ") : "Nothing to commit or push"}
          </span>
          <Button
            onClick={onOpenSourceControl}
            className="h-7 shrink-0 rounded-md border border-line-strong px-2.5 text-meta font-medium text-fg-primary transition-colors hover:bg-surface-hover"
          >
            {state.nextAction}
          </Button>
        </div>
      </header>

      {state.baseMoved || state.preparation !== "Ready" || source ? (
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          {state.baseMoved ? (
            <Notice icon={CircleAlert} tone="attention">
              {state.baseRef} moved since this started. Review what came in before updating.
            </Notice>
          ) : null}
          {state.preparation !== "Ready" ? (
            <Notice
              icon={Terminal}
              tone={setupFailed ? "error" : "quiet"}
              action={
                setupFailed ? (
                  <NoticeButton disabled={busy} onClick={() => onExecute({ action: "retry_setup" })}>
                    Retry
                  </NoticeButton>
                ) : undefined
              }
            >
              {state.preparation}
            </Notice>
          ) : null}
          {source ? (
            <Notice
              icon={CornerDownRight}
              tone="quiet"
              action={<NoticeButton onClick={() => onOpenThread(source)}>Open</NoticeButton>}
            >
              Builds on{" "}
              {quoted(state.threads.find((thread) => thread.id === source)?.title) ?? "another thread"}
            </Notice>
          ) : null}
        </div>
      ) : null}

      {others.length > 0 ? (
        <Section label="Threads here">
          {others.map((thread) => (
            <ChooserRow
              key={thread.id}
              icon={MessageSquare}
              title={thread.title}
              trailing={
                thread.active ? <span /> : <span className="text-caption text-fg-tertiary">Archived</span>
              }
              onClick={() => onOpenThread(thread.id)}
            />
          ))}
        </Section>
      ) : null}

      <Section label="Linked">
        {state.pulls.map((pull) => (
          <LinkRow
            key={pull.url}
            icon={<PullStateIcon state={pullStateKind(pull.state)} size={14} />}
            url={pull.url}
            title={pull.title}
            facts={pullFacts(pull)}
            busy={busy}
            watching={pull.watching}
            onWatch={() => onExecute({ action: pull.watching ? "unwatch" : "watch", url: pull.url })}
            onUnlink={() => onExecute({ action: "unlink", url: pull.url })}
          />
        ))}
        {state.issues.map((issue) => (
          <LinkRow
            key={issue.url}
            icon={
              <CircleDot
                size={14}
                strokeWidth={2}
                className={`shrink-0 ${issue.state === "OPEN" ? "text-success-text" : "text-merged"}`}
              />
            }
            url={issue.url}
            title={issue.title}
            facts={issue.state === "OPEN" ? [] : [{ word: "Closed", tone: "text-fg-tertiary" }]}
            busy={busy}
            onUnlink={() => onExecute({ action: "unlink_issue", url: issue.url })}
          />
        ))}
        <LinkField
          busy={busy}
          first={state.pulls.length === 0 && state.issues.length === 0}
          onLink={(url, kind) => onExecute({ action: kind === "pull" ? "link" : "link_issue", url })}
        />
      </Section>

      <Section label="Review">
        <div className="flex items-center gap-2 px-1.5 pb-1">
          <ToggleGroup
            aria-label="What to review"
            value={[scope]}
            onValueChange={(value) => {
              const next = value[0] as Scope | undefined;
              if (next) onScope(next);
            }}
            className="flex min-w-0 flex-1 gap-0.5 rounded-lg bg-surface-sunken p-0.5"
          >
            {scopes.map((option) => (
              <Toggle key={option.value} value={option.value} className={toggleClass}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
          {diff ? (
            <IconButton icon={X} label="Hide the diff" onClick={onHideDiff} />
          ) : (
            <Button
              disabled={busy}
              onClick={onDiff}
              className="h-7 shrink-0 rounded-md border border-line-strong px-2.5 text-meta font-medium text-fg-primary transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              Show diff
            </Button>
          )}
        </div>
        {diff ? <DiffView diff={diff} head={state.head} busy={busy} onAgain={onDiff} /> : null}
      </Section>
    </div>
  );
}

const quoted = (title: string | undefined) => (title === undefined ? undefined : `“${title}”`);

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="border-t border-line-subtle px-1.5 pt-2 pb-2">
      <h3 className="px-2 pb-1 text-caption font-medium text-fg-tertiary select-none">{label}</h3>
      {children}
    </section>
  );
}

const noticeTone = {
  attention: "border-attention/25 bg-attention/6 text-attention-text",
  error: "border-error/25 bg-error/6 text-error-text",
  quiet: "border-line-subtle bg-surface-sunken text-fg-secondary",
} as const;

function Notice({
  icon: Icon,
  tone,
  action,
  children,
}: {
  icon: LucideIcon;
  tone: keyof typeof noticeTone;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border py-1.5 pr-1.5 pl-2.5 text-meta ${noticeTone[tone]}`}
    >
      <Icon size={13} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 flex-1 py-0.5">{children}</span>
      {action}
    </div>
  );
}

function NoticeButton({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      disabled={disabled ?? false}
      onClick={onClick}
      className="h-6 shrink-0 rounded-md px-2 font-medium text-fg-primary transition-colors hover:bg-surface-hover disabled:opacity-40"
    >
      {children}
    </Button>
  );
}

const rowAction =
  "grid size-7 place-items-center rounded-md text-fg-tertiary transition-[color,background-color,opacity] hover:bg-surface-active hover:text-fg-primary disabled:opacity-40";

/** A linked pull request or issue: its state, its title, how its checks and review stand. */
function LinkRow({
  icon,
  url,
  title,
  facts,
  busy,
  watching,
  onWatch,
  onUnlink,
}: {
  icon: ReactNode;
  url: string;
  title: string;
  facts: ReadonlyArray<{ readonly word: string; readonly tone: string }>;
  busy: boolean;
  /** Present for a pull request, which Cerium can watch for checks and reviews. */
  watching?: boolean;
  onWatch?: () => void;
  onUnlink: () => void;
}) {
  const number = linkNumber(url);
  return (
    <div className="group flex items-center gap-2.5 rounded-lg py-1 pr-1 pl-2 hover:bg-surface-hover">
      <span className={facts.length > 0 ? "self-start pt-[3px]" : ""}>{icon}</span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={url}
        className="flex min-w-0 flex-1 flex-col py-0.5 outline-none"
      >
        <span className="flex min-w-0 items-baseline gap-1.5 text-body">
          <span className="truncate text-fg-primary group-hover:underline group-hover:underline-offset-2">
            {title}
          </span>
          {number ? (
            <span className="shrink-0 text-meta text-fg-tertiary tabular-nums">#{number}</span>
          ) : null}
        </span>
        {facts.length > 0 ? (
          <span className="flex gap-1.5 text-caption">
            {facts.map((fact, index) => (
              <span key={fact.word} className="flex gap-1.5">
                {index > 0 ? <span className="text-fg-disabled">·</span> : null}
                <span className={fact.tone}>{fact.word}</span>
              </span>
            ))}
          </span>
        ) : null}
      </a>
      {onWatch ? (
        <Tooltip label={watching ? "Stop watching" : "Watch checks and reviews"}>
          <Button
            aria-label={watching ? "Stop watching" : "Watch checks and reviews"}
            aria-pressed={watching ?? false}
            disabled={busy}
            onClick={onWatch}
            className={`${rowAction} ${watching ? "text-fg-primary" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
          >
            {watching ? <BellRing size={14} strokeWidth={1.75} /> : <Bell size={14} strokeWidth={1.75} />}
          </Button>
        </Tooltip>
      ) : null}
      <Tooltip label="Unlink">
        <Button
          aria-label="Unlink"
          disabled={busy}
          onClick={onUnlink}
          className={`${rowAction} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
        >
          <X size={14} strokeWidth={1.75} />
        </Button>
      </Tooltip>
    </div>
  );
}

/** Pastes a pull request's or an issue's address, linked as whichever it is. */
function LinkField({
  busy,
  first,
  onLink,
}: {
  busy: boolean;
  /** Nothing is linked yet: the field says what linking is for. */
  first: boolean;
  onLink: (url: string, kind: "pull" | "issue") => void;
}) {
  const [url, setUrl] = useState("");
  const kind = linkKindOf(url);
  const wrong = url.trim() !== "" && kind === undefined;
  return (
    <form
      className="px-1.5 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === undefined) return;
        onLink(url.trim(), kind);
        setUrl("");
      }}
    >
      <div className="flex h-8 items-center gap-2 rounded-lg border border-line-subtle pr-1 pl-2.5 transition-colors focus-within:border-line-strong">
        <Link2 size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        <input
          type="url"
          aria-label="Pull request or issue address"
          placeholder={first ? "Link a pull request or issue to follow it here" : "Link another"}
          spellCheck={false}
          autoComplete="off"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent text-body text-fg-primary outline-none placeholder:text-fg-tertiary"
        />
        {kind ? (
          <Button
            type="submit"
            disabled={busy}
            className="h-6 shrink-0 rounded-md bg-surface-selected px-2 text-meta font-medium text-fg-primary transition-colors hover:bg-surface-active disabled:opacity-40"
          >
            Link {kind === "pull" ? "pull request" : "issue"}
          </Button>
        ) : null}
      </div>
      {wrong ? (
        <p className="px-1 pt-1 text-caption text-error-text">
          Paste a GitHub pull request's or issue's address.
        </p>
      ) : null}
    </form>
  );
}

const lineTone = (line: string) =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
    ? "text-fg-tertiary"
    : line.startsWith("@@")
      ? "bg-surface-hover text-fg-tertiary"
      : line.startsWith("+")
        ? "bg-success/8 text-success-text"
        : line.startsWith("-")
          ? "bg-error/8 text-error-text"
          : "text-fg-secondary";

function DiffView({
  diff,
  head,
  busy,
  onAgain,
}: {
  diff: { readonly text: string; readonly revision: string };
  head: string;
  busy: boolean;
  onAgain: () => void;
}) {
  const lines = diff.text === "" ? [] : diff.text.replace(/\n$/, "").split("\n");
  const stale = diff.revision !== "" && diff.revision !== head;
  return (
    <div className="px-1.5 pt-1.5">
      <div className="flex h-6 items-center gap-2 px-1 text-caption text-fg-tertiary">
        <span>
          At <span className="font-mono">{diff.revision.slice(0, 7) || "—"}</span>
        </span>
        {stale ? (
          <>
            <span className="text-attention-text">The branch moved since</span>
            <button
              type="button"
              disabled={busy}
              onClick={onAgain}
              className="ml-auto font-medium text-fg-secondary hover:text-fg-primary disabled:opacity-40"
            >
              Read again
            </button>
          </>
        ) : null}
      </div>
      {lines.length === 0 ? (
        <p className="rounded-lg border border-line-subtle bg-surface-sunken px-3 py-4 text-center text-meta text-fg-tertiary">
          No changes in this scope.
        </p>
      ) : (
        <div className="max-h-72 overflow-auto overscroll-contain rounded-lg border border-line-subtle bg-surface-sunken py-1.5 font-mono text-caption">
          <div className="min-w-max">
            {lines.slice(0, DIFF_LINES).map((line, index) => (
              <div key={index} className={`px-3 whitespace-pre ${lineTone(line)}`}>
                {line || " "}
              </div>
            ))}
          </div>
          {lines.length > DIFF_LINES ? (
            <p className="px-3 pt-1.5 font-sans text-fg-tertiary">
              {lines.length - DIFF_LINES} more lines in the source control panel.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Checkouts({
  checkouts,
  current,
  busy,
  onBack,
  onRemove,
}: {
  checkouts: ReadonlyArray<CheckoutInfo> | undefined;
  current: string | undefined;
  busy: boolean;
  onBack: () => void;
  onRemove: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <ViewHeader title="Checkouts" onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {checkouts === undefined ? (
          <p className="px-2 py-3 text-center text-meta text-fg-tertiary">Reading the checkouts…</p>
        ) : (
          checkouts.map((checkout) => {
            const here = current !== undefined && samePath(current, checkout.path);
            const detail = checkoutDetail(checkout);
            const removable = checkout.managed === true && checkout.threads.every((thread) => !thread.active);
            return (
              <div
                key={checkout.id}
                className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg py-1.5 pr-1 pl-2 hover:bg-surface-hover"
              >
                <GitBranch
                  size={14}
                  strokeWidth={1.75}
                  className={`text-fg-tertiary ${detail ? "mt-[3px] self-start" : ""}`}
                />
                <span className="flex min-w-0 flex-col" title={checkout.path}>
                  <span className="truncate text-body text-fg-primary">{checkout.branch || "Detached"}</span>
                  {detail ? <span className="truncate text-caption text-fg-tertiary">{detail}</span> : null}
                </span>
                {here ? (
                  <span className="pr-1.5 text-caption text-fg-tertiary">This thread's</span>
                ) : removable ? (
                  <Tooltip label="Remove">
                    <Button
                      aria-label={`Remove ${pathTail(checkout.path)}`}
                      disabled={busy}
                      onClick={() => onRemove(checkout.path)}
                      className={`${rowAction} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </Button>
                  </Tooltip>
                ) : (
                  <span />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Unavailable({ onRetry, onMove }: { onRetry: () => void; onMove: () => void }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <Popover.Title className="text-reading font-medium">Workspace unavailable</Popover.Title>
        <Popover.Description className="text-meta text-fg-secondary">
          Cerium can't read this thread's checkout. It may have been moved or removed.
        </Popover.Description>
      </div>
      <div className="flex justify-end gap-2">
        <DialogButton onClick={onRetry}>Retry</DialogButton>
        <DialogButton tone="primary" onClick={onMove}>
          Choose another…
        </DialogButton>
      </div>
    </div>
  );
}
