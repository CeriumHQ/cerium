import { Button } from "@base-ui/react/button";
import type { ProviderId } from "@cerium/protocol";
import {
  Ellipsis,
  FolderTree,
  GalleryVerticalEnd,
  GitBranch,
  GitPullRequestArrow,
  Globe,
  Minus,
  PanelLeft,
  Play,
  Square,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { CeriumBrand } from "../components/CeriumBrand.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { MenuCheckboxItem, MenuPopup, MenuRoot, MenuTrigger } from "../components/ui/Menu.tsx";
import { Tooltip } from "../components/ui/Tooltip.tsx";
import { useShortcut } from "../lib/shortcuts.ts";
import { WEB } from "../backend/target.ts";
import type { AppMode } from "./mode.ts";
import { RAIL, type SidePanelId } from "./panelLayout.ts";

/**
 * The system draws its minimize / maximize / close buttons here (Electron's titleBarOverlay), Windows
 * its own and Electron Linux's. A Mac's traffic lights sit at the other end (`--titlebar-inset`).
 */
const CAPTION_BUTTON_WIDTH = 46;

export interface PreviewToggleProps {
  readonly open: boolean;
  /** The thread has a page open, which its agents may be driving out of sight. */
  readonly live: boolean;
  readonly onToggle: () => void;
}

interface TitlebarProps {
  /** The selected thread, if any. */
  readonly thread?: { readonly title: string; readonly project?: string };
  /** A page that covers the threads (Settings, GitHub), by its title: it replaces the thread's title and controls. */
  readonly page?: string;
  /** The page lays out its own list, so the sidebar's place, and the controls over it, fold away. */
  readonly bare?: boolean;
  /** A thread's own window, which has no sidebar to toggle and no new thread to start: the mark alone. */
  readonly alone?: boolean;
  readonly mode: AppMode;
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
  /** The project's run button: starts its run command in a thread terminal, and stops it while it runs. */
  readonly run?: { readonly running: boolean; readonly onToggle: () => void };
  /** The Preview pane's button, offered while the thread can have a browser: the desktop app's own threads. */
  readonly preview?: PreviewToggleProps;
  /** Which of the account's computers the window drives, once there's a choice. */
  readonly machinePicker?: ReactNode;
  /** The open threads' tabs, which take the title's place. */
  readonly tabs?: ReactNode;
}

export function Titlebar({
  thread,
  page,
  bare = false,
  alone = false,
  mode,
  sidebarOpen,
  sidebarWidth,
  resizing,
  onToggleSidebar,
  onNewThread,
  agents,
  panels,
  onTogglePanel,
  terminal,
  run,
  preview,
  machinePicker,
  tabs,
}: TitlebarProps) {
  const covered = page !== undefined;
  const showSidebar = !bare && (sidebarOpen || covered);
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 pl-(--titlebar-inset) [app-region:drag]">
      {/*
       * Spans the rail and the sidebar while it shows, so the toggle sits over the sidebar's own edge;
       * shrinks to its contents, in step with the sidebar, once it folds. Their width, less the
       * titlebar's left padding (past the traffic lights on a Mac) and the gutter beside the sidebar.
       * The mark sits centred over the rail.
       */}
      <div
        style={{
          width: showSidebar ? `calc(${RAIL + sidebarWidth - 6}px - var(--titlebar-inset))` : "fit-content",
        }}
        className={`flex shrink-0 items-center gap-2.5 pr-2 [interpolate-size:allow-keywords] ${
          resizing ? "" : "transition-[width] duration-200 ease-out-soft"
        }`}
      >
        <span style={{ paddingLeft: `max(0px, ${(RAIL + 6 - 22) / 2}px - var(--titlebar-inset))` }}>
          <CeriumBrand nameClassName="max-lg:hidden" />
        </span>
        {alone ? null : (
          <div
            inert={covered}
            className={`ml-auto flex items-center transition-opacity duration-200 [app-region:no-drag] ${covered ? "opacity-0" : ""}`}
          >
            <IconButton
              icon={PanelLeft}
              label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              shortcut={useShortcut("toggle-sidebar")}
              onClick={onToggleSidebar}
            />
            {/* The tabs bring their own. */}
            {sidebarOpen || tabs ? null : (
              <IconButton
                icon={SquarePen}
                label={mode === "work" ? "New thread" : "New chat"}
                shortcut={useShortcut("new-thread")}
                onClick={onNewThread}
              />
            )}
          </div>
        )}
      </div>

      {/*
       * The thread's tabs start where the conversation does, and what they leave of the bar drags the
       * window. Without tabs the title sits in the middle of what's left of the bar, with the controls
       * in a column of their own at the end, so it stays put as the agents button comes and goes; it
       * gives way to them only once it's too long for the room.
       */}
      <div
        className={`h-full min-w-0 flex-1 items-center ${
          tabs && !covered ? "flex gap-2" : "grid grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]"
        }`}
      >
        {tabs && !covered ? (
          <div className="flex h-full min-w-0 flex-1 items-center">{tabs}</div>
        ) : (
          <>
            <div />
            {/* Plain text until the thread has actions to offer, so it also drags the window. */}
            {covered ? (
              <p className="px-2.5 text-body font-medium text-fg-primary">{page}</p>
            ) : thread ? (
              <p className="flex min-w-0 items-baseline gap-2 px-2.5 text-body">
                <span className="truncate font-medium text-fg-primary">{thread.title}</span>
                {thread.project ? <span className="shrink-0 text-fg-tertiary">{thread.project}</span> : null}
              </p>
            ) : (
              <div />
            )}
          </>
        )}
        <div className="flex h-full shrink-0 items-center justify-end">
          {run && !covered ? <RunToggle running={run.running} onToggle={run.onToggle} /> : null}
          {covered ? null : (
            <CompactPanelMenu
              agents={agents}
              panels={panels}
              onTogglePanel={onTogglePanel}
              terminal={terminal}
              preview={preview}
            />
          )}
          {machinePicker}
          <CaptionButtons />
        </div>
      </div>
    </header>
  );
}

/**
 * The bar's panel buttons folded into one menu, so the thread's title keeps its room: the agents keep
 * theirs, and the preview, terminal and other panels sit in the menu, whose button shows when one is
 * open (or a page is live in the preview).
 */
export function CompactPanelMenu({
  agents,
  panels,
  onTogglePanel,
  terminal,
  preview,
}: {
  agents: ReadonlyArray<ProviderId>;
  panels: Partial<Record<SidePanelId, boolean>>;
  onTogglePanel: (panel: SidePanelId) => void;
  terminal?: { readonly open: boolean; readonly onToggle: () => void } | undefined;
  preview?: PreviewToggleProps | undefined;
}) {
  const items = [
    { id: "artifacts", label: "Artifacts", icon: GalleryVerticalEnd },
    { id: "github", label: "GitHub", icon: GitPullRequestArrow },
    { id: "git", label: "Source control", icon: GitBranch },
    { id: "files", label: "Files", icon: FolderTree },
  ] as const;
  const offered = items.filter((item) => panels[item.id] !== undefined);
  const anyOpen =
    (terminal?.open ?? false) || (preview?.open ?? false) || offered.some((item) => panels[item.id] === true);
  return (
    <>
      {terminal || preview || offered.length > 0 ? (
        <MenuRoot>
          <MenuTrigger>
            <Button
              aria-label="Panels"
              className={`relative mr-1 grid size-7 shrink-0 place-items-center rounded-md transition-colors [app-region:no-drag] active:bg-surface-active data-popup-open:bg-surface-selected data-popup-open:text-fg-primary max-md:size-10 ${
                anyOpen ? "text-fg-primary" : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
              }`}
            >
              <Ellipsis size={18} strokeWidth={1.75} />
              {preview?.live && !anyOpen ? (
                <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" />
              ) : null}
            </Button>
          </MenuTrigger>
          <MenuPopup>
            {preview ? (
              <MenuCheckboxItem
                icon={Globe}
                checked={preview.open}
                onCheckedChange={preview.onToggle}
                closeOnClick
              >
                Preview
              </MenuCheckboxItem>
            ) : null}
            {terminal ? (
              <MenuCheckboxItem
                icon={SquareTerminal}
                checked={terminal.open}
                onCheckedChange={terminal.onToggle}
                closeOnClick
              >
                Terminal
              </MenuCheckboxItem>
            ) : null}
            {offered.map((item) => (
              <MenuCheckboxItem
                key={item.id}
                icon={item.icon}
                checked={panels[item.id] ?? false}
                onCheckedChange={() => onTogglePanel(item.id)}
                closeOnClick
              >
                {item.label}
              </MenuCheckboxItem>
            ))}
          </MenuPopup>
        </MenuRoot>
      ) : null}
      {panels.agents === undefined || agents.length === 0 ? null : (
        <AgentsToggle agents={agents} open={panels.agents} onToggle={() => onTogglePanel("agents")} />
      )}
    </>
  );
}

/** Starts the open work thread's project run command, or stops it while it runs. */
export function RunToggle({ running, onToggle }: { running: boolean; onToggle: () => void }) {
  return (
    <Tooltip label={running ? "Stop run" : "Run project"}>
      <Button
        onClick={onToggle}
        aria-label={running ? "Stop run" : "Run project"}
        className={`mr-1 grid size-7 place-items-center rounded-md transition-colors [app-region:no-drag] max-md:size-10 ${
          running
            ? "bg-surface-selected text-fg-primary"
            : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
        }`}
      >
        {running ? <Square size={13} strokeWidth={1.75} /> : <Play size={14} strokeWidth={1.75} />}
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
    <Tooltip label={open ? "Hide agents" : "Show agents"} shortcut={useShortcut("toggle-agents")}>
      <Button
        onClick={onToggle}
        aria-pressed={open}
        className={`mr-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-meta transition-colors [app-region:no-drag] ${
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
 * In Electron, the system draws the real caption buttons over this space. The browser preview draws
 * stand-ins so the layout matches.
 */
function CaptionButtons() {
  const width = CAPTION_BUTTON_WIDTH * 3;
  // A browser window has its own.
  if (WEB) return <div className="w-1.5 shrink-0" />;
  if (document.documentElement.dataset["shell"] === "electron") {
    // Window Controls Overlay reports the free titlebar area; everything right of it is the system's.
    return (
      <div
        className="shrink-0"
        style={{ width: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))" }}
      />
    );
  }
  return (
    <div
      className="flex h-full text-fg-secondary in-data-[platform=darwin]:hidden"
      style={{ width }}
      aria-hidden="true"
    >
      {[Minus, Square, X].map((Icon, index) => (
        <span key={index} className="grid h-full flex-1 place-items-center">
          <Icon size={index === 1 ? 10 : 13} strokeWidth={1.25} />
        </span>
      ))}
    </div>
  );
}
