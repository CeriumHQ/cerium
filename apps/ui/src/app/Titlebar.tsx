import { Bot, ChevronDown, PanelLeft } from "lucide-react";

import { IconButton } from "../components/ui/IconButton.tsx";

/** Width Windows reserves for the native minimize / maximize / close buttons (titleBarOverlay). */
const CAPTION_BUTTONS_WIDTH = 138;

interface TitlebarProps {
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
}

export function Titlebar({ inspectorOpen, onToggleInspector }: TitlebarProps) {
  return (
    <header
      className="flex h-10 shrink-0 items-center gap-2 px-3 [app-region:drag]"
      style={{ paddingRight: CAPTION_BUTTONS_WIDTH }}
    >
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

      <div className={`rounded-md [app-region:no-drag] ${inspectorOpen ? "bg-surface-selected" : ""}`}>
        <IconButton
          icon={Bot}
          label={inspectorOpen ? "Hide agents" : "Show agents"}
          shortcut="Ctrl J"
          onClick={onToggleInspector}
        />
      </div>
    </header>
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
