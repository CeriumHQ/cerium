import { Button } from "@base-ui/react/button";
import {
  Crosshair,
  Scan,
  LoaderCircle,
  Monitor,
  Moon,
  CircleAlert,
  Smartphone,
  Sun,
  Tablet,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Tooltip } from "../../components/ui/Tooltip.tsx";

import type { PreviewTheme as Theme, PreviewViewport as Viewport } from "@cerium/browser/inspector";
const VIEWPORTS: ReadonlyArray<readonly [Viewport, LucideIcon, string]> = [
  ["fit", Scan, "Fit to pane"],
  ["desktop", Monitor, "Desktop"],
  ["tablet", Tablet, "Tablet"],
  ["phone", Smartphone, "Phone"],
];

const THEMES: ReadonlyArray<readonly [Theme, LucideIcon, string]> = [
  ["system", Monitor, "System theme"],
  ["light", Sun, "Light theme"],
  ["dark", Moon, "Dark theme"],
];

/** A few icon buttons of which one is chosen, sharing one rounded track. */
function Segments<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<readonly [T, LucideIcon, string]>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset aria-label={label} className="flex shrink-0 rounded-md bg-surface-sunken p-0.5">
      {options.map(([id, Icon, name]) => (
        <Tooltip key={id} label={name}>
          <Button
            aria-pressed={value === id}
            aria-label={name}
            disabled={disabled}
            onClick={() => value !== id && onChange(id)}
            className={`grid h-6 w-7 place-items-center rounded transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-8 pointer-coarse:w-8 ${
              value === id
                ? "bg-surface-raised text-fg-primary shadow-sm"
                : "text-fg-tertiary hover:text-fg-primary"
            }`}
          >
            <Icon size={14} strokeWidth={1.75} />
          </Button>
        </Tooltip>
      ))}
    </fieldset>
  );
}

/**
 * The preview's own controls beside its address bar: point at an element, the page's size and
 * theme, and the issues gathered so far with one click to send them. Wraps under the address on
 * a narrow pane.
 */
export function PreviewTools({
  picking,
  viewport,
  theme,
  issueCount,
  sending,
  disabled,
  onPick,
  onViewport,
  onTheme,
  onSend,
}: {
  picking: boolean;
  viewport: Viewport;
  theme: Theme;
  issueCount: number;
  sending: boolean;
  /** No page to act on yet. */
  disabled: boolean;
  onPick: () => void;
  onViewport: (value: Viewport) => void;
  onTheme: (value: Theme) => void;
  onSend: () => void;
}) {
  return (
    <div className="@container flex min-h-9 min-w-0 shrink-0 flex-wrap items-center justify-between gap-1 border-b border-line-subtle px-1.5 py-1">
      <div className="flex items-center gap-1.5">
        <Tooltip label={picking ? "Stop picking" : "Point at an element"}>
          <Button
            aria-label="Point at an element"
            aria-pressed={picking}
            disabled={disabled}
            onClick={onPick}
            className={`grid size-7 shrink-0 place-items-center rounded-md outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:text-fg-disabled pointer-coarse:size-10 ${
              picking
                ? "bg-accent text-accent-fg"
                : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary active:bg-surface-active"
            }`}
          >
            <Crosshair size={15} strokeWidth={1.75} />
          </Button>
        </Tooltip>
        <Segments
          label="Viewport"
          options={VIEWPORTS}
          value={viewport}
          disabled={disabled}
          onChange={onViewport}
        />
        <Segments label="Theme" options={THEMES} value={theme} disabled={disabled} onChange={onTheme} />
      </div>
      {issueCount > 0 ? (
        <Tooltip label={`Send ${issueCount} preview ${issueCount === 1 ? "issue" : "issues"} to agent`}>
          <Button
            aria-label={`Send ${issueCount} preview ${issueCount === 1 ? "issue" : "issues"} to agent`}
            disabled={sending}
            aria-busy={sending || undefined}
            onClick={onSend}
            className="flex h-6 items-center gap-1.5 rounded-md border border-line-subtle px-2 text-meta text-fg-secondary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {sending ? (
              <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" />
            ) : (
              <CircleAlert size={13} className="text-error-text" />
            )}
            <span className="tabular-nums">{issueCount}</span>
            <span className="hidden @[385px]:inline">Send to agent</span>
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** A quiet line under the header: how to pick while picking, or what went wrong. */
export function PreviewNotice({
  tone,
  children,
  onDismiss,
}: {
  tone: "hint" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex min-h-7 shrink-0 items-center gap-2 border-b border-line-subtle px-3 text-meta ${
        tone === "error" ? "bg-error/8 text-error-text" : "bg-accent/6 text-fg-secondary"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {onDismiss ? (
        <Button
          aria-label="Dismiss"
          onClick={onDismiss}
          className="grid size-5 shrink-0 place-items-center rounded hover:bg-surface-hover"
        >
          <X size={12} strokeWidth={2} />
        </Button>
      ) : null}
    </div>
  );
}
