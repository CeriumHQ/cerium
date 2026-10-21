import { Button } from "@base-ui/react/button";
import type { ProviderId } from "@cerium/protocol";
import {
  FolderTree,
  GalleryVerticalEnd,
  GitBranch,
  GitPullRequestArrow,
  Minus,
  PanelLeft,
  Square,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { CeriumMark } from "../components/CeriumMark.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Tooltip } from "../components/ui/Tooltip.tsx";
import { WEB } from "../backend/target.ts";
import { ModeSwitch, type AppMode } from "./ModeSwitch.tsx";
import type { SidePanelId } from "./panelLayout.ts";

/** Windows draws its minimize / maximize / close buttons here (Electron's titleBarOverlay). */
const CAPTION_BUTTON_WIDTH = 46;

interface TitlebarProps {
  /** The selected thread, if any. */
  readonly thread?: { readonly title: string; readonly project?: string };
  /** Settings replace the thread's title and controls. */
  readonly settingsOpen: boolean;
  readonly mode: AppMode;
  readonly onModeChange: (mode: AppMode) => void;
  readonly sidebarOpen: boolean;
  /** The sidebar's width while it shows, so the controls above it end where it does. */
  readonly sidebarWidth: number;
  /** The sidebar is being dragged to another width: the controls follow it without easing. */
  readonly resizing: boolean;
  readonly onToggleSidebar: () => void;
  /** Offered here while the sidebar, which has the main button for it, is folded away, and no tabs show. */
  readonly onNewThread: () => void;
  /** Providers of the selected thread's agents, lead first. */
  readonly agents: ReadonlyArray<ProviderId>;
  /** The side panels offered now, each by whether it's open: each has a button. */
  readonly panels: Partial<Record<SidePanelId, boolean>>;
  readonly onTogglePanel: (panel: SidePanelId) => void;
  /** The terminal drawer's button, offered while the thread can have a terminal. */
  readonly terminal?: { readonly open: boolean; readonly onToggle: () => void };
  /** Which of the account's computers the window drives, once there's a choice. */
  readonly machinePicker?: ReactNode;
  /** The open threads' tabs, which take the title's place. */
  readonly tabs?: ReactNode;
}

export function Titlebar({
  thread,
  settingsOpen,
  mode,
  onModeChange,
  sidebarOpen,
  sidebarWidth,
  resizing,
  onToggleSidebar,
  onNewThread,
  agents,
  panels,
  onTogglePanel,
  terminal,
  machinePicker,
  tabs,
}: TitlebarProps) {
  const showSidebar = sidebarOpen || settingsOpen;
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 pl-3 [app-region:drag]">
      {/*
       * Spans the sidebar while it shows, so the toggle sits over the sidebar's own edge; shrinks to
       * its contents, in step with the sidebar, once it folds. The sidebar's width, less the titlebar's
       * left padding and the gutter beside it.
       */}
      <div
        style={{ width: showSidebar ? sidebarWidth - 18 : "fit-content" }}
        className={`flex shrink-0 items-center gap-2.5 pr-2 [interpolate-size:allow-keywords] ${
          resizing ? "" : "transition-[width] duration-200 ease-out-soft"
        }`}
      >
        <CeriumMark size={16} landing className="ml-1.5 text-fg-primary" />
        <ModeSwitch mode={mode} onChange={onModeChange} />
        <div
          inert={settingsOpen}
          className={`ml-auto flex items-center transition-opacity duration-200 [app-region:no-drag] ${settingsOpen ? "opacity-0" : ""}`}
        >
          <IconButton
            icon={PanelLeft}
            label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            shortcut="Ctrl B"
            onClick={onToggleSidebar}
          />
          {/* The tabs bring their own. */}
          {sidebarOpen || tabs ? null : (
            <IconButton
              icon={SquarePen}
              label={mode === "work" ? "New thread" : "New chat"}
              shortcut="Ctrl N"
              onClick={onNewThread}
            />
          )}
        </div>
      </div>

      {/*
       * The thread's tabs start where the conversation does, and what they leave of the bar drags the
       * window. Without tabs the title sits in the middle of what's left of the bar, with the controls
       * in a column of their own at the end, so it stays put as the agents button comes and goes; it
       * gives way to them only once it's too long for the room.
       */}
      <div
        className={`h-full min-w-0 flex-1 items-center ${
          tabs && !settingsOpen ? "flex gap-2" : "grid grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]"
        }`}
      >
        {tabs && !settingsOpen ? (
          <div className="flex h-full min-w-0 flex-1 items-center">{tabs}</div>
        ) : (
          <>
            <div />
            {/* Plain text until the thread has actions to offer, so it also drags the window. */}
            {settingsOpen ? (
              <p className="px-2.5 text-[13px] font-medium text-fg-primary">Settings</p>
            ) : thread ? (
              <p className="flex min-w-0 items-baseline gap-2 px-2.5 text-[13px]">
                <span className="truncate font-medium text-fg-primary">{thread.title}</span>
                {thread.project ? <span className="shrink-0 text-fg-tertiary">{thread.project}</span> : null}
              </p>
            ) : (
              <div />
            )}
          </>
        )}
        <div className="flex h-full shrink-0 items-center justify-end">
          {terminal && !settingsOpen ? (
            <TerminalToggle open={terminal.open} onToggle={terminal.onToggle} />
          ) : null}
          {settingsOpen ? null : (
            <PanelToggles agents={agents} panels={panels} onTogglePanel={onTogglePanel} />
          )}
          {machinePicker}
          <CaptionButtons />
        </div>
      </div>
    </header>
  );
}

/** The buttons of the side panels on offer, in the order they sit in the bar. */
export function PanelToggles({
  agents,
  panels,
  onTogglePanel,
}: {
  agents: ReadonlyArray<ProviderId>;
  panels: Partial<Record<SidePanelId, boolean>>;
  onTogglePanel: (panel: SidePanelId) => void;
}) {
  return (
    <>
      {panels.artifacts === undefined ? null : (
        <ArtifactsToggle open={panels.artifacts} onToggle={() => onTogglePanel("artifacts")} />
      )}
      {panels.github === undefined ? null : (
        <GitHubToggle open={panels.github} onToggle={() => onTogglePanel("github")} />
      )}
      {panels.git === undefined ? null : (
        <SourceControlToggle open={panels.git} onToggle={() => onTogglePanel("git")} />
      )}
      {panels.files === undefined ? null : (
        <FilesToggle open={panels.files} onToggle={() => onTogglePanel("files")} />
      )}
      {panels.agents === undefined || agents.length === 0 ? null : (
        <AgentsToggle agents={agents} open={panels.agents} onToggle={() => onTogglePanel("agents")} />
      )}
    </>
  );
}

/** Opens Source control, which shares the agents panel's place. */
export function SourceControlToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={open ? "Hide source control" : "Show source control"} shortcut="Ctrl Shift G">
      <Button
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Source control"
        className={`mr-1 grid size-7 place-items-center rounded-md transition-colors [app-region:no-drag] max-md:size-10 ${
          open
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <GitBranch size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** Opens GitHub's pull requests and issues, which share the agents panel's place. */
export function GitHubToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={open ? "Hide GitHub" : "Show GitHub"} shortcut="Ctrl Shift H">
      <Button
        onClick={onToggle}
        aria-pressed={open}
        aria-label="GitHub"
        className={`mr-1 grid size-7 place-items-center rounded-md transition-colors [app-region:no-drag] max-md:size-10 ${
          open
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <GitPullRequestArrow size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** Opens the files panel, which shares the agents panel's place. */
export function FilesToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={open ? "Hide files" : "Show files"} shortcut="Ctrl Shift E">
      <Button
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Files"
        className={`mr-1 grid size-7 place-items-center rounded-md transition-colors [app-region:no-drag] max-md:size-10 ${
          open
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <FolderTree size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** Opens the artifacts panel, which shares the agents panel's place. */
export function ArtifactsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={open ? "Hide artifacts" : "Show artifacts"}>
      <Button
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Artifacts"
        className={`mr-1 grid size-7 place-items-center rounded-md transition-colors [app-region:no-drag] max-md:size-10 ${
          open
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <GalleryVerticalEnd size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** Shows the open thread's terminals under its conversation. */
export function TerminalToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={open ? "Hide terminal" : "Show terminal"} shortcut="Ctrl `">
      <Button
        onClick={onToggle}
        aria-pressed={open}
        aria-label="Terminal"
        className={`mr-1 grid size-7 place-items-center rounded-md transition-colors [app-region:no-drag] max-md:size-10 ${
          open
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <SquareTerminal size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** The thread's agents at a glance; opens the agent inspector. */
export function AgentsToggle({
  agents,
  open,
  onToggle,
}: {
  agents: ReadonlyArray<ProviderId>;
  open: boolean;
  onToggle: () => void;
}) {
  const providers = [...new Set(agents)];
  return (
    <Tooltip label={open ? "Hide agents" : "Show agents"} shortcut="Ctrl J">
      <Button
        onClick={onToggle}
        aria-pressed={open}
        className={`mr-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors [app-region:no-drag] ${
          open
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        <span className="flex items-center -space-x-1">
          {providers.map((provider) => (
            <span
              key={provider}
              className="grid size-[18px] place-items-center rounded-full border border-line-strong bg-surface-raised"
            >
              <ProviderLogo provider={provider} size={10} />
            </span>
          ))}
        </span>
        <span className="tabular-nums">
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </span>
      </Button>
    </Tooltip>
  );
}

/**
 * In Electron, Windows draws the real caption buttons over this space. The browser preview draws
 * stand-ins so the layout matches.
 */
function CaptionButtons() {
  const width = CAPTION_BUTTON_WIDTH * 3;
  // A browser window has its own.
  if (WEB) return <div className="w-1.5 shrink-0" />;
  if (document.documentElement.dataset["shell"] === "electron") {
    // Window Controls Overlay reports the free titlebar area; everything right of it is Windows'.
    return (
      <div
        className="shrink-0"
        style={{ width: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))" }}
      />
    );
  }
  return (
    <div className="flex h-full text-fg-secondary" style={{ width }} aria-hidden="true">
      {[Minus, Square, X].map((Icon, index) => (
        <span key={index} className="grid h-full flex-1 place-items-center">
          <Icon size={index === 1 ? 10 : 13} strokeWidth={1.25} />
        </span>
      ))}
    </div>
  );
}
