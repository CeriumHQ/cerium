import type { ProviderId, ThreadId } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FolderTree,
  GalleryVerticalEnd,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  Monitor,
  Play,
  RefreshCw,
  Settings2,
  Square,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { workspaceAtom } from "../backend/sourceControl.ts";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { Button } from "../components/ui/Button.tsx";
import { Sheet, SheetRow, SheetSection } from "../components/ui/Sheet.tsx";
import { WorkspaceStatusBody, type Lineage } from "../features/git/WorkspaceStatus.tsx";
import { pathTail } from "../features/git/workspace.ts";
import { StatusMarkView } from "./CompactBar.tsx";
import { isDegraded, type ShownStatus } from "./connectionStatus.ts";
import type { SidePanelId } from "./panelLayout.ts";
import type { PreviewToggleProps, RunProps } from "./Titlebar.tsx";

// The compact thread's one place for what the wide window keeps in its titlebar: how the line to
// its computer stands, its workspace, its run and actions, its panels and its agents.

/** The open thread's workspace, for the Thread sheet's Workspace row and page. */
export interface CompactWorkspace {
  readonly threadId: ThreadId;
  readonly checkoutFolder: string;
  /** The project's folder, whose checkouts a thread can move to. */
  readonly projectRoot: string;
  /** The branch to show until the workspace has been read. */
  readonly branch?: string | undefined;
  /** The thread works in a worktree of its own, rather than the project's checkout. */
  readonly worktree?: boolean | undefined;
  readonly lineage?: Lineage | undefined;
  readonly onOpenSourceControl: () => void;
  readonly onOpenThread: (threadId: string) => void;
}

export interface ThreadSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /** The status the window shows (`useConnectionStatus`): a degraded one puts the Connection card on top. */
  readonly connectionStatus?: ShownStatus | undefined;
  /** Tries the line again now; the Retry button spins until what it returns settles. */
  readonly onRetry?: (() => unknown) | undefined;
  /** Offered while the account has another computer to drive. */
  readonly onSwitchMachine?: (() => void) | undefined;
  readonly hasOtherMachines?: boolean | undefined;
  readonly workspace?: CompactWorkspace | undefined;
  readonly run?: RunProps | undefined;
  readonly agents: ReadonlyArray<ProviderId>;
  readonly panels: Partial<Record<SidePanelId, boolean>>;
  readonly onTogglePanel: (panel: SidePanelId) => void;
  readonly terminal?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
  readonly preview?: PreviewToggleProps | undefined;
}

/** The least time the Retry button spins, so a quick answer still reads as a try. */
const RETRY_MIN_MS = 600;

/** What the Connection card says under the computer's name. */
export function connectionDetail(status: ShownStatus): string | undefined {
  switch (status.kind) {
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      return status.presence ?? "Offline";
    case "cloud":
      return "Cloud copy · messages queue until connected";
    case "outdated":
      return "Update Cerium on this computer";
    default:
      return undefined;
  }
}

/** A run or one of the project's actions is going: the `⋯` button's dot says so first. */
export const runBusy = (run: RunProps | undefined) =>
  run !== undefined && (run.running || (run.actions ?? []).some((action) => action.running));

export function ThreadSheet({
  open,
  onOpenChange,
  title,
  connectionStatus,
  onRetry,
  onSwitchMachine,
  hasOtherMachines = false,
  workspace,
  run,
  agents,
  panels,
  onTogglePanel,
  terminal,
  preview,
}: ThreadSheetProps) {
  const [page, setPage] = useState<"main" | "workspace">("main");
  const close = () => onOpenChange(false);
  const body = useRef<HTMLDivElement>(null);
  const fromHeight = useRef<number>(undefined);
  const goTo = (next: "main" | "workspace") => {
    fromHeight.current = body.current?.offsetHeight;
    setPage(next);
  };

  // The project's actions are read again each time the sheet opens, in case their file changed.
  const onMenuOpen = run?.onMenuOpen;
  useEffect(() => {
    if (open) onMenuOpen?.();
  }, [open, onMenuOpen]);

  // The sheet's height follows the page it shows, as NoticeSwap's does.
  useLayoutEffect(() => {
    const element = body.current;
    const from = fromHeight.current;
    fromHeight.current = undefined;
    if (!element || from === undefined || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = element.offsetHeight;
    if (from === to) return;
    const animation = element.animate(
      { height: [`${from}px`, `${to}px`], overflow: ["hidden", "hidden"] },
      {
        duration: 200,
        easing: getComputedStyle(element).getPropertyValue("--ease-out-soft").trim() || "ease-out",
      },
    );
    return () => animation.cancel();
  }, [page]);

  const degraded = connectionStatus !== undefined && isDegraded(connectionStatus);
  const pageClass =
    "flex flex-col transition-[translate,opacity] duration-200 ease-out-soft starting:translate-x-6 starting:opacity-0 motion-reduce:starting:translate-x-0";

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      onOpenChangeComplete={(next) => {
        if (!next) setPage("main");
      }}
    >
      <div ref={body}>
        {page === "workspace" && workspace ? (
          <div key="workspace" className={pageClass}>
            <SheetRow
              onClick={() => goTo("main")}
              icon={<ChevronLeft size={18} strokeWidth={1.75} />}
              className="text-fg-secondary"
            >
              Back
            </SheetRow>
            <WorkspaceStatusBody
              threadId={workspace.threadId}
              projectRoot={workspace.projectRoot}
              lineage={workspace.lineage}
              open={open}
              onClose={close}
              onOpenSourceControl={() => {
                close();
                workspace.onOpenSourceControl();
              }}
              onOpenThread={workspace.onOpenThread}
            />
          </div>
        ) : (
          <div key="main" className={`${pageClass} pb-1`}>
            {degraded ? (
              <ConnectionCard
                status={connectionStatus}
                onRetry={onRetry}
                onSwitchMachine={
                  hasOtherMachines && onSwitchMachine
                    ? () => {
                        close();
                        onSwitchMachine();
                      }
                    : undefined
                }
              />
            ) : null}
            {workspace ? (
              <SheetSection title="Workspace">
                <WorkspaceSummary workspace={workspace} onOpen={() => goTo("workspace")} />
              </SheetSection>
            ) : null}
            {run ? <RunSection run={run} onClose={close} /> : null}
            <PanelsSection
              panels={panels}
              onTogglePanel={onTogglePanel}
              terminal={terminal}
              preview={preview}
              onClose={close}
            />
            {panels.agents === undefined || agents.length === 0 ? null : (
              <SheetSection title="Agents">
                <SheetRow
                  onClick={() => {
                    close();
                    onTogglePanel("agents");
                  }}
                  aria-pressed={panels.agents}
                  trailing={<ChevronRight size={16} strokeWidth={1.75} />}
                >
                  <span className="flex min-w-0 items-center gap-3 tabular-nums">
                    <ProviderMarks agents={agents} />
                    {agents.length} {agents.length === 1 ? "agent" : "agents"}
                  </span>
                </SheetRow>
              </SheetSection>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function ConnectionCard({
  status,
  onRetry,
  onSwitchMachine,
}: {
  status: ShownStatus;
  onRetry: (() => unknown) | undefined;
  onSwitchMachine: (() => void) | undefined;
}) {
  const [retrying, setRetrying] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const retry = async () => {
    if (retrying || onRetry === undefined) return;
    setRetrying(true);
    const started = Date.now();
    try {
      await onRetry();
    } catch {
      // The card stays up while the line is still down; there's nothing more to say.
    } finally {
      const left = RETRY_MIN_MS - (Date.now() - started);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
      if (live.current) setRetrying(false);
    }
  };
  const machine = "machine" in status ? status.machine : undefined;
  const detail = connectionDetail(status);
  return (
    <div className="flex flex-col pt-2">
      <div className="flex min-h-14 items-center gap-3 rounded-xl bg-surface-sunken py-2 pr-2 pl-3">
        <StatusMarkView status={status} />
        <div className="flex min-w-0 flex-1 flex-col">
          {machine === undefined ? null : (
            <span className="truncate text-[15px] font-medium text-fg-primary">{machine}</span>
          )}
          <span
            className={`truncate tabular-nums ${machine === undefined ? "text-[15px] text-fg-primary" : "text-meta text-fg-tertiary"}`}
          >
            {detail}
          </span>
        </div>
        {onRetry ? (
          <Button
            tone="primary"
            size="md"
            aria-label="Retry connection"
            disabled={retrying}
            onClick={() => void retry()}
            className="h-9 min-w-20 pointer-coarse:h-10 max-md:h-10"
          >
            {retrying ? (
              <RefreshCw
                aria-hidden
                size={14}
                strokeWidth={2}
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              "Retry"
            )}
          </Button>
        ) : null}
      </div>
      {onSwitchMachine ? (
        <SheetRow
          onClick={onSwitchMachine}
          icon={<Monitor size={16} strokeWidth={1.75} />}
          trailing={<ChevronRight size={16} strokeWidth={1.75} />}
        >
          Switch computer
        </SheetRow>
      ) : null}
    </div>
  );
}

function WorkspaceSummary({ workspace, onOpen }: { workspace: CompactWorkspace; onOpen: () => void }) {
  const result = useAtomValue(workspaceAtom(workspace.threadId));
  const state = AsyncResult.getOrElse(result, () => undefined)?.snapshot;
  const branch = state?.branch ?? workspace.branch;
  const changed = state ? state.staged + state.unstaged : 0;
  const folder = state?.root ?? workspace.checkoutFolder;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Workspace${branch ? `, ${branch}` : ""}`}
      className="flex h-14 w-full shrink-0 items-center gap-3 rounded-xl bg-surface-sunken px-3 text-left outline-none select-none transition-colors active:bg-surface-active focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <GitBranch size={16} strokeWidth={1.75} className="shrink-0 text-fg-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[14px] text-fg-primary">{branch ?? "Workspace"}</span>
        {folder ? (
          <span className="truncate text-meta text-fg-tertiary">
            {workspace.worktree ? "worktree" : "checkout"} · {pathTail(folder)}
          </span>
        ) : null}
      </span>
      {state ? (
        <span className="flex shrink-0 items-center gap-2 text-meta text-fg-tertiary tabular-nums">
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
        </span>
      ) : null}
      <ChevronRight size={16} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
    </button>
  );
}

const runningDot = <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-running" />;

function RunSection({ run, onClose }: { run: RunProps; onClose: () => void }) {
  const actions = run.actions ?? [];
  return (
    <SheetSection title="Run">
      {run.running ? (
        <div className="flex h-12 items-center gap-3 pr-1 pl-3 text-[15px]">
          <span className="grid size-5 shrink-0 place-items-center">{runningDot}</span>
          <span className="min-w-0 flex-1 truncate">Running</span>
          <Button tone="quiet" size="md" onClick={run.onToggle} aria-label="Stop run">
            <Square aria-hidden size={13} strokeWidth={1.75} />
            Stop
          </Button>
        </div>
      ) : (
        <div className="px-1 pb-1">
          <Button
            tone="primary"
            size="md"
            className="w-full"
            onClick={() => {
              onClose();
              run.onToggle();
            }}
          >
            <Play aria-hidden size={14} strokeWidth={1.75} />
            Run project
          </Button>
        </div>
      )}
      {actions.map((action) => (
        <SheetRow
          key={action.name}
          aria-label={action.running ? `Stop ${action.name}` : `Run ${action.name}`}
          onClick={() => {
            if (!action.running) onClose();
            run.onAction?.(action.name);
          }}
          icon={
            action.running ? (
              runningDot
            ) : (
              <span aria-hidden className="size-1.5 rounded-full ring-1 ring-fg-tertiary" />
            )
          }
          trailing={
            action.running ? (
              <span className="flex items-center gap-1 text-fg-secondary">
                <Square aria-hidden size={13} strokeWidth={1.75} />
                Stop
              </span>
            ) : (
              <Play aria-hidden size={14} strokeWidth={1.75} />
            )
          }
        >
          {action.name}
        </SheetRow>
      ))}
      {run.onEditActions ? (
        <SheetRow
          onClick={() => {
            onClose();
            run.onEditActions?.();
          }}
          icon={<Settings2 size={16} strokeWidth={1.75} />}
          className="text-fg-secondary"
        >
          Edit actions…
        </SheetRow>
      ) : null}
    </SheetSection>
  );
}

interface Tile {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly open: boolean;
  readonly live?: boolean;
  readonly onToggle: () => void;
}

const sidePanelTiles = [
  { id: "files", label: "Files", icon: FolderTree },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "artifacts", label: "Artifacts", icon: GalleryVerticalEnd },
  { id: "github", label: "GitHub", icon: GitPullRequestArrow },
] as const;

function PanelsSection({
  panels,
  onTogglePanel,
  terminal,
  preview,
  onClose,
}: {
  panels: Partial<Record<SidePanelId, boolean>>;
  onTogglePanel: (panel: SidePanelId) => void;
  terminal: ThreadSheetProps["terminal"];
  preview: ThreadSheetProps["preview"];
  onClose: () => void;
}) {
  const tiles: Tile[] = [
    ...(terminal
      ? [
          {
            key: "terminal",
            label: "Terminal",
            icon: SquareTerminal,
            open: terminal.open,
            onToggle: terminal.onToggle,
          },
        ]
      : []),
    ...(preview
      ? [
          {
            key: "preview",
            label: "Preview",
            icon: Globe,
            open: preview.open,
            live: preview.live,
            onToggle: preview.onToggle,
          },
        ]
      : []),
    ...sidePanelTiles
      .filter((tile) => panels[tile.id] !== undefined)
      .map((tile) => ({
        key: tile.id,
        label: tile.label,
        icon: tile.icon,
        open: panels[tile.id] === true,
        onToggle: () => onTogglePanel(tile.id),
      })),
  ];
  if (tiles.length === 0) return null;
  return (
    <SheetSection title="Panels">
      <div className="grid grid-cols-4 gap-2 px-1">
        {tiles.map(({ key, label, icon: Icon, open, live, onToggle }) => (
          <button
            key={key}
            type="button"
            aria-pressed={open}
            onClick={() => {
              onClose();
              onToggle();
            }}
            className={`relative flex h-16 flex-col items-center justify-center gap-1 rounded-xl text-[12px] outline-none select-none transition-colors duration-150 ease-out-soft focus-visible:ring-2 focus-visible:ring-focus-ring active:bg-surface-active ${
              open ? "bg-surface-selected text-fg-primary" : "bg-surface-sunken text-fg-secondary"
            }`}
          >
            <Icon aria-hidden size={18} strokeWidth={1.75} />
            <span className="max-w-full truncate px-1">{label}</span>
            {live && !open ? (
              <span aria-hidden className="absolute top-2 right-2 size-1.5 rounded-full bg-accent" />
            ) : null}
          </button>
        ))}
      </div>
    </SheetSection>
  );
}

function ProviderMarks({ agents }: { agents: ReadonlyArray<ProviderId> }) {
  return (
    <span className="flex items-center -space-x-1">
      {[...new Set(agents)].map((provider) => (
        <span
          key={provider}
          className="grid size-[18px] place-items-center rounded-full border border-line-strong bg-surface-raised"
        >
          <ProviderLogo provider={provider} size={10} />
        </span>
      ))}
    </span>
  );
}
