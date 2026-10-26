import { Button } from "@base-ui/react/button";
import { ChevronRight } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ComponentType } from "react";

import { WEB } from "../../backend/target.ts";
import { SlidingHighlight } from "../../components/SlidingHighlight.tsx";
import { SearchBar } from "../../components/ui/SearchBar.tsx";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { AccountSettings } from "./Account.tsx";
import { AgentSettings } from "./Agents.tsx";
import { AppearanceSettings } from "./Appearance.tsx";
import { GeneralSettings } from "./General.tsx";
import { HarnessSettings } from "./Harnesses.tsx";
import { KeyboardSettings } from "./Keyboard.tsx";
import { NotificationSettings } from "./Notifications.tsx";
import { PromptSettings } from "./Prompts.tsx";
import { settingsGlyphs, type GlyphProps } from "./glyphs.tsx";
import { SourceControlSettings } from "./SourceControl.tsx";
import { UsageSettings } from "./Usage.tsx";

export type SettingsCategory =
  | "general"
  | "account"
  | "notifications"
  | "appearance"
  | "agents"
  | "prompts"
  | "harnesses"
  | "sourceControl"
  | "usage"
  | "keyboard";

const categories: ReadonlyArray<{
  readonly id: SettingsCategory;
  readonly label: string;
  /** What the category holds, a phone's list shows under the name. */
  readonly description: string;
  readonly icon: ComponentType<GlyphProps>;
}> = [
  // The desktop's own: starting at login, Discord, dictation and updates. A browser has none of them.
  ...(WEB
    ? []
    : [
        {
          id: "general" as const,
          label: "General",
          description: "Startup, dictation, updates",
          icon: settingsGlyphs.general,
        },
      ]),
  { id: "account", label: "Account", description: "Sign-in and your devices", icon: settingsGlyphs.account },
  // Push notifications in a browser; the desktop's own through its shell.
  ...(WEB || window.cerium?.notify
    ? [
        {
          id: "notifications" as const,
          label: "Notifications",
          description: "Alerts on this computer",
          icon: settingsGlyphs.notifications,
        },
      ]
    : []),
  {
    id: "appearance",
    label: "Appearance",
    description: "Palette and light or dark",
    icon: settingsGlyphs.appearance,
  },
  { id: "agents", label: "Agents", description: "Models, effort and defaults", icon: settingsGlyphs.agents },
  {
    id: "prompts",
    label: "Prompts",
    description: "Text and commands on /",
    icon: settingsGlyphs.prompts,
  },
  {
    id: "harnesses",
    label: "Harnesses",
    description: "Installed CLIs and sign-ins",
    icon: settingsGlyphs.harnesses,
  },
  {
    id: "sourceControl",
    label: "Source control",
    description: "Git and GitHub",
    icon: settingsGlyphs.sourceControl,
  },
  { id: "usage", label: "Usage", description: "Limits and spend", icon: settingsGlyphs.usage },
  { id: "keyboard", label: "Keyboard", description: "Shortcuts", icon: settingsGlyphs.keyboard },
];

const settingLabel = (id: SettingsCategory) => categories.find((each) => each.id === id)?.label ?? "";

/** Every setting by name, with the category that holds it, for the sidebar's search. */
const settingsIndex: ReadonlyArray<{ readonly name: string; readonly category: SettingsCategory }> = (
  [
    ["general", "This computer"],
    ["general", "Show activity on Discord"],
    ["general", "Dictation language"],
    ["general", "Speech model"],
    ["general", "Updates"],
    ["general", "Update channel"],
    ["account", "Sign out"],
    ["account", "Devices"],
    ["account", "Device name"],
    ["notifications", "Show notifications"],
    ["notifications", "Play a sound"],
    ["notifications", "Count on the taskbar"],
    ["notifications", "Notify me when"],
    ["appearance", "Theme"],
    ["appearance", "Light or dark mode"],
    ["appearance", "Conversation text size"],
    ["appearance", "Window scale"],
    ["agents", "Default model"],
    ["agents", "Reasoning effort"],
    ["agents", "Access"],
    ["agents", "Name new threads"],
    ["agents", "Advisor model"],
    ["agents", "MCP servers"],
    ["agents", "Pick effort automatically"],
    ["agents", "OpenRouter key"],
    ["agents", "Roster"],
    ["prompts", "Saved prompts"],
    ["harnesses", "Installed CLIs"],
    ["harnesses", "Sign-ins"],
    ["sourceControl", "Where new work threads run"],
    ["sourceControl", "Project scripts"],
    ["usage", "Limits"],
    ["usage", "Tokens & cost"],
    ["usage", "Free resets"],
    ["keyboard", "Send messages with"],
    ["keyboard", "Shortcuts"],
  ] as const
)
  .map(([category, name]) => ({ category, name }))
  .filter(({ category }) => categories.some((each) => each.id === category));

/** The categories this window offers, which the command palette lists as pages to jump to. */
export const settingsPages = categories;

/** A category's name, as the narrow window's top bar shows it over its page. */
export const settingsLabel = (category: SettingsCategory) =>
  categories.find((each) => each.id === category)?.label ?? "Settings";

interface SettingsNavProps {
  readonly category: SettingsCategory;
  readonly onSelect: (category: SettingsCategory) => void;
  /** Settings are showing: the current category takes focus, ready for the arrow keys. */
  readonly active: boolean;
  /**
   * The narrow window's list of categories, each opening its page; its top bar has the way back.
   * Keyboard shortcuts are left out: a phone has no keyboard to speak of.
   */
  readonly compact?: boolean;
}

/** The sidebar while settings are open: the way back, and the categories. */
export function SettingsNav({ category, onSelect, active, compact = false }: SettingsNavProps) {
  const [query, setQuery] = useState("");
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
            .map(({ id, label, description, icon: Icon }) => (
              <Button
                key={id}
                onClick={() => onSelect(id)}
                className="flex min-h-14 items-center gap-3.5 px-3 py-2 text-left transition-colors active:bg-surface-active"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-window text-fg-secondary">
                  <Icon size={20} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-reading text-fg-primary">{label}</span>
                  <span className="truncate text-meta text-fg-tertiary">{description}</span>
                </span>
                <ChevronRight size={17} strokeWidth={1.75} className="text-fg-tertiary" />
              </Button>
            ))}
        </div>
      </nav>
    );
  }

  const needle = query.trim().toLowerCase();
  const hits =
    needle === ""
      ? []
      : settingsIndex.filter(
          ({ name, category: id }) =>
            name.toLowerCase().includes(needle) || settingLabel(id).toLowerCase().includes(needle),
        );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-2 pl-3.5">
        <h2 className="text-reading font-semibold text-fg-primary max-md:text-base">Settings</h2>
      </div>
      <div className="mx-2 mb-2.5 overflow-hidden rounded-lg border border-line-subtle bg-surface-sunken [&>div]:h-8 [&>div]:border-b-0 [&>div]:pl-2.5">
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search settings"
          label="Search all settings"
        />
      </div>
      {needle !== "" ? (
        <div className="flex flex-col gap-px px-2">
          {hits.length === 0 ? (
            <p className="px-2 py-1.5 text-meta text-fg-tertiary">No settings match.</p>
          ) : (
            hits.map(({ name, category: id }) => {
              const Icon = settingsGlyphs[id];
              return (
                <Button
                  key={`${id}:${name}`}
                  onClick={() => {
                    setQuery("");
                    onSelect(id);
                  }}
                  className="flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-body text-fg-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-primary"
                >
                  <Icon size={16} className="shrink-0 text-fg-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="shrink-0 text-meta text-fg-tertiary">{settingLabel(id)}</span>
                </Button>
              );
            })
          )}
        </div>
      ) : null}
      <nav
        ref={nav}
        aria-label="Settings"
        className={`relative isolate flex-col gap-px px-2 ${needle === "" ? "flex" : "hidden"}`}
      >
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
            <Icon size={16} className={id === category ? "text-fg-primary" : "text-fg-tertiary"} />
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
    case "prompts":
      return <PromptSettings key={category} />;
    case "sourceControl":
      return <SourceControlSettings key={category} />;
    case "usage":
      return <UsageSettings key={category} {...(openHarnesses ? { onOpenHarnesses: openHarnesses } : {})} />;
    case "keyboard":
      return <KeyboardSettings key={category} />;
  }
}
