import { Button } from "@base-ui/react/button";
import type { ProviderId } from "@cerium/protocol";
import { ChevronDown, Minus, PanelLeft, Square, X } from "lucide-react";

import { ProviderLogo } from "../components/ProviderLogo.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Tooltip } from "../components/ui/Tooltip.tsx";

/** Windows draws its minimize / maximize / close buttons here (Electron's titleBarOverlay). */
const CAPTION_BUTTON_WIDTH = 46;

interface TitlebarProps {
  /** Providers of the selected thread's agents, lead first. */
  readonly agents: ReadonlyArray<ProviderId>;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}

export function Titlebar({ agents, inspectorOpen, onToggleInspector }: TitlebarProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 pl-3 [app-region:drag]">
      <div className="flex items-center gap-2">
        <CeriumMark />
        <span className="text-[13px] font-medium tracking-tight text-fg-primary">Cerium</span>
      </div>
      <div className="[app-region:no-drag]">
        <IconButton icon={PanelLeft} label="Toggle sidebar" shortcut="Ctrl B" />
      </div>

      <div className="flex flex-1 justify-center">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] text-fg-secondary transition-colors [app-region:no-drag] hover:bg-surface-hover hover:text-fg-primary"
        >
          <span className="font-medium text-fg-primary">Fix flaky auth test</span>
          <span className="text-fg-tertiary">cerium</span>
          <ChevronDown size={13} className="text-fg-tertiary" />
        </button>
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
  if (document.documentElement.dataset["shell"] === "electron") return <div style={{ width }} />;
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

/** Cerium's mark: a cut gem, after cerium oxide, the compound that polishes glass. */
function CeriumMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" className="text-fg-primary">
      <path d="M12 2.5 20.5 8v8L12 21.5 3.5 16V8Z" fill="currentColor" opacity="0.92" />
      <path
        d="M12 2.5V12l8.5-4M12 12 3.5 8M12 12v9.5"
        stroke="var(--surface-window)"
        strokeWidth="1.1"
        strokeOpacity="0.9"
        fill="none"
      />
    </svg>
  );
}
