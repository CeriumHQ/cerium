import { Button } from "@base-ui/react/button";
import {
  ArrowLeft,
  Bell,
  Blocks,
  Bot,
  ChevronRight,
  CircleUserRound,
  Gauge,
  GitBranch,
  Keyboard,
  Palette,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { WEB } from "../../backend/target.ts";
import { SlidingHighlight } from "../../components/SlidingHighlight.tsx";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { AccountSettings } from "./Account.tsx";
import { AgentSettings } from "./Agents.tsx";
import { AppearanceSettings } from "./Appearance.tsx";
import { GeneralSettings } from "./General.tsx";
import { HarnessSettings } from "./Harnesses.tsx";
import { KeyboardSettings } from "./Keyboard.tsx";
import { NotificationSettings } from "./Notifications.tsx";
import { SourceControlSettings } from "./SourceControl.tsx";
import { UsageSettings } from "./Usage.tsx";

export type SettingsCategory =
  | "general"
  | "account"
  | "notifications"
  | "appearance"
  | "agents"
  | "harnesses"
  | "sourceControl"
  | "usage"
  | "keyboard";

const categories: ReadonlyArray<{
  readonly id: SettingsCategory;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  // The desktop's own: starting at login, Discord, dictation and updates. A browser has none of them.
  ...(WEB ? [] : [{ id: "general" as const, label: "General", icon: Settings2 }]),
  { id: "account", label: "Account", icon: CircleUserRound },
  // Push notifications in a browser; the desktop's own through its shell.
  ...(WEB || window.cerium?.notify
    ? [{ id: "notifications" as const, label: "Notifications", icon: Bell }]
    : []),
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "harnesses", label: "Harnesses", icon: Blocks },
  { id: "sourceControl", label: "Source control", icon: GitBranch },
  { id: "usage", label: "Usage", icon: Gauge },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
];

/** The categories this window offers, which the command palette lists as pages to jump to. */
export const settingsPages = categories;

/** A category's name, as the narrow window's top bar shows it over its page. */
export const settingsLabel = (category: SettingsCategory) =>
  categories.find((each) => each.id === category)?.label ?? "Settings";

interface SettingsNavProps {
  readonly category: SettingsCategory;
  readonly onSelect: (category: SettingsCategory) => void;
  /** Where leaving settings goes back to. */
  readonly backLabel: string;
  readonly onBack: () => void;
  /** Settings are showing: the current category takes focus, ready for the arrow keys. */
  readonly active: boolean;
  /**
   * The narrow window's list of categories, each opening its page; its top bar has the way back.
   * Keyboard shortcuts are left out: a phone has no keyboard to speak of.
   */
  readonly compact?: boolean;
}

/** The sidebar while settings are open: the way back, and the categories. */
export function SettingsNav({
  category,
  onSelect,
  backLabel,
  onBack,
  active,
  compact = false,
}: SettingsNavProps) {
  const nav = useRef<HTMLElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) current.current?.focus();
  }, [active]);
  // Focus follows the selection when the arrow keys move it, and when a page's own link to another
  // one (its focused button gone with it) leaves focus nowhere.
  const followFocus = useEffectEvent(() => {
    const focused = document.activeElement;
    const lost = active && (focused === null || focused === document.body);
    if (lost || nav.current?.contains(focused)) current.current?.focus();
  });
  useEffect(() => followFocus(), [category]);

  // Arrow keys move between categories, like a list of tabs, and Home and End jump to either end.
  const index = categories.findIndex((each) => each.id === category);
  const target: Record<string, number> = {
    ArrowDown: (index + 1) % categories.length,
    ArrowUp: (index - 1 + categories.length) % categories.length,
    Home: 0,
    End: categories.length - 1,
  };

  if (compact) {
    return (
      <nav aria-label="Settings" className="flex flex-col px-3 pt-2">
        <div className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-xl border border-line-subtle bg-surface-raised">
          {categories
            .filter(({ id }) => id !== "keyboard")
            .map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                onClick={() => onSelect(id)}
                className="flex h-12 items-center gap-3 px-3.5 text-left text-reading text-fg-primary transition-colors active:bg-surface-active"
              >
                <Icon size={18} strokeWidth={1.75} className="text-fg-secondary" />
                <span className="flex-1">{label}</span>
                <ChevronRight size={17} strokeWidth={1.75} className="text-fg-tertiary" />
              </Button>
            ))}
        </div>
      </nav>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex px-2 pb-2">
        <Button
          onClick={onBack}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-line-subtle bg-surface-raised px-2.5 text-body font-medium text-fg-primary shadow-raised transition-colors duration-150 hover:bg-surface-panel active:bg-surface-active"
        >
          <ArrowLeft size={14} strokeWidth={1.75} className="text-fg-secondary" />
          {backLabel}
          <kbd className="ml-auto font-sans text-caption text-fg-tertiary">Esc</kbd>
        </Button>
      </div>

      <p className="px-4 pt-2 pb-1.5 text-meta font-medium text-fg-secondary/80">Settings</p>
      <nav ref={nav} aria-label="Settings" className="relative isolate flex flex-col gap-px px-2">
        <SlidingHighlight within={nav} active={category} className="rounded-md bg-surface-selected" />
        {categories.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            ref={id === category ? current : undefined}
            {...(id === category ? { "data-highlight-active": "" } : {})}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => {
              const next = categories[target[event.key] ?? -1];
              if (next === undefined) return;
              event.preventDefault();
              onSelect(next.id);
            }}
            // One stop for Tab: the open category, from which the arrow keys move.
            tabIndex={id === category ? 0 : -1}
            aria-current={id === category ? "page" : undefined}
            // The ring is a hairline inside the row: the open page's row is already highlighted, and a
            // full ring around that read as a heavy white box when settings took focus on opening.
            className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-body transition-colors duration-150 focus-visible:outline-1 focus-visible:-outline-offset-1 ${
              id === category
                ? "font-medium text-fg-primary"
                : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
            }`}
          >
            <Icon
              size={15}
              strokeWidth={1.75}
              className={id === category ? "text-fg-primary" : "text-fg-tertiary"}
            />
            {label}
          </Button>
        ))}
      </nav>
    </div>
  );
}

/** The open category's page, filling the main panel. */
export function SettingsView({
  category,
  harnesses,
  onOpen,
}: {
  category: SettingsCategory;
  /** Which harnesses can run, for the choices that depend on them. */
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Opens another category, for a page that points the way to one. */
  onOpen?: (category: SettingsCategory) => void;
}) {
  const openHarnesses = onOpen ? () => onOpen("harnesses") : undefined;
  switch (category) {
    case "general":
      return <GeneralSettings key={category} />;
    case "account":
      return <AccountSettings key={category} />;
    case "notifications":
      return <NotificationSettings key={category} />;
    case "appearance":
      return <AppearanceSettings key={category} />;
    case "agents":
      return (
        <AgentSettings
          key={category}
          harnesses={harnesses}
          {...(openHarnesses ? { onOpenHarnesses: openHarnesses } : {})}
        />
      );
    case "harnesses":
      return <HarnessSettings key={category} />;
    case "sourceControl":
      return <SourceControlSettings key={category} />;
    case "usage":
      return <UsageSettings key={category} {...(openHarnesses ? { onOpenHarnesses: openHarnesses } : {})} />;
    case "keyboard":
      return <KeyboardSettings key={category} />;
  }
}
