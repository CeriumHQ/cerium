import { Button } from "@base-ui/react/button";
import type { ProviderId } from "@cerium/protocol";
import { ChevronDown, Minus, PanelLeft, Square, X } from "lucide-react";

import { CeriumMark } from "../components/CeriumMark.tsx";
import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Tooltip } from "../components/ui/Tooltip.tsx";
import { ModeSwitch, type AppMode } from "./ModeSwitch.tsx";

/** Windows draws its minimize / maximize / close buttons here (Electron's titleBarOverlay). */
const CAPTION_BUTTON_WIDTH = 46;

interface TitlebarProps {
  /** The selected thread, if any. */
  readonly thread?: { readonly title: string; readonly project?: string };
  readonly mode: AppMode;
  readonly onModeChange: (mode: AppMode) => void;
  /** Providers of the selected thread's agents, lead first. */
  readonly agents: ReadonlyArray<ProviderId>;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}

export function Titlebar({
  thread,
  mode,
  onModeChange,
  agents,
  inspectorOpen,
  onToggleInspector,
}: TitlebarProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 pl-3 [app-region:drag]">
      <div className="flex items-center gap-2">
        <CeriumMark size={16} className="text-fg-primary" />
        <span className="text-[13px] font-medium tracking-tight text-fg-primary">Cerium</span>
      </div>
      <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden="true" />
      <ModeSwitch mode={mode} onChange={onModeChange} />
      <div className="[app-region:no-drag]">
        <IconButton icon={PanelLeft} label="Toggle sidebar" shortcut="Ctrl B" />
      </div>

      <div className="flex min-w-0 flex-1 justify-center">
        {thread ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-fg-secondary transition-colors [app-region:no-drag] hover:bg-surface-hover hover:text-fg-primary"
          >
            <span className="truncate font-medium text-fg-primary">{thread.title}</span>
            {thread.project ? <span className="shrink-0 text-fg-tertiary">{thread.project}</span> : null}
            <ChevronDown size={13} className="shrink-0 text-fg-tertiary" />
          </button>
        ) : null}
      </div>

      {agents.length > 0 ? (
        <AgentsToggle agents={agents} open={inspectorOpen} onToggle={onToggleInspector} />
      ) : null}
      <CaptionButtons />
    </header>
  );
}

/** The thread's agents at a glance; opens the agent inspector. */
function AgentsToggle({
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
