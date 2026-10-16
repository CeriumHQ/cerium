import { ChevronDown, PanelLeft, PanelRight } from "lucide-react";

/** Width Windows reserves for the native minimize / maximize / close buttons (titleBarOverlay). */
const CAPTION_BUTTONS_WIDTH = 138;

export function Titlebar() {
  return (
    <header
      className="flex h-10 shrink-0 items-center gap-2 px-3 [app-region:drag]"
      style={{ paddingRight: CAPTION_BUTTONS_WIDTH }}
    >
      <div className="flex items-center gap-2">
        <CeriumMark />
        <span className="text-[13px] font-medium tracking-tight text-fg-primary">Cerium</span>
      </div>
      <button
        type="button"
        className="ml-1 rounded-md p-1.5 text-fg-tertiary transition-colors [app-region:no-drag] hover:bg-surface-hover hover:text-fg-secondary"
        aria-label="Toggle sidebar"
      >
        <PanelLeft size={15} strokeWidth={1.75} />
      </button>

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

      <button
        type="button"
        className="rounded-md p-1.5 text-fg-tertiary transition-colors [app-region:no-drag] hover:bg-surface-hover hover:text-fg-secondary"
        aria-label="Toggle agents panel"
      >
        <PanelRight size={15} strokeWidth={1.75} />
      </button>
    </header>
  );
}

/** Cerium's mark: a cut gem, after cerium oxide, the compound that polishes glass. */
function CeriumMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="cerium-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-strong)" />
        </linearGradient>
      </defs>
      <path d="M12 2.5 20.5 8v8L12 21.5 3.5 16V8Z" fill="url(#cerium-mark)" opacity="0.9" />
      <path
        d="M12 2.5V12l8.5-4M12 12 3.5 8M12 12v9.5"
        stroke="oklch(1 0 0 / 0.45)"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );
}
