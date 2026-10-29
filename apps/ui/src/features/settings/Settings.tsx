import { Button } from "@base-ui/react/button";
import { ChevronRight } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ComponentType } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { WEB } from "../../backend/target.ts";
import { SlidingHighlight } from "../../components/SlidingHighlight.tsx";
import { SearchBar } from "../../components/ui/SearchBar.tsx";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { AccountSettings, DeviceSettings } from "./Account.tsx";
import { AdvisorSettings, RosterSettings, ThreadSettings } from "./Agents.tsx";
import { AssistantSettings } from "./Assistants.tsx";
import { AppearanceSettings } from "./Appearance.tsx";
import { EffortRouterSettings } from "./EffortRouter.tsx";
import { DictationSettings, DiscordSettings, GeneralSettings, UpdateSettings } from "./General.tsx";
import { HarnessSettings } from "./Harnesses.tsx";
import { McpSettings, SkillsSettings } from "./Hub.tsx";
import { KeyboardSettings } from "./Keyboard.tsx";
import { NotificationSettings } from "./Notifications.tsx";
import { SettingsPlace, SettingsProject } from "./parts.tsx";
import { PromptSettings } from "./Prompts.tsx";
import { settingsGlyphs, type GlyphProps } from "./glyphs.tsx";
import { SourceControlSettings } from "./SourceControl.tsx";
import { UsageSettings } from "./Usage.tsx";

export type SettingsCategory =
  | "general"
  | "appearance"
  | "notifications"
  | "keyboard"
  | "dictation"
  | "updates"
  | "threads"
  | "roster"
  | "advisor"
  | "prompts"
  | "effortRouter"
  | "harnesses"
  | "mcp"
  | "skills"
  | "usage"
  | "sourceControl"
  | "discord"
  | "assistants"
  | "account"
  | "devices";

interface Page {
  readonly id: SettingsCategory;
  readonly label: string;
  /** What the page holds, a phone's list shows under the name. */
  readonly description: string;
  readonly icon: ComponentType<GlyphProps>;
}

const page = (
  id: SettingsCategory,
  label: string,
  description: string,
  icon: ComponentType<GlyphProps>,
  offered = true,
): ReadonlyArray<Page> => (offered ? [{ id, label, description, icon }] : []);

// The desktop's own pages (starting at login, dictation, updates, Discord) are left out of a browser,
// which has none of them; notifications are a browser's push, or the desktop shell's own.
const desktop = !WEB;

/** The pages under the headings the sidebar groups them in, each heading a part of Cerium. */
const groups: ReadonlyArray<{ readonly label: string; readonly pages: ReadonlyArray<Page> }> = [
  {
    label: "App",
    pages: [
      ...page("general", "General", "Startup, storage, crash reports", settingsGlyphs.general, desktop),
      ...page("appearance", "Appearance", "Theme, mode and size", settingsGlyphs.appearance),
      ...page(
        "notifications",
        "Notifications",
        "Alerts on this device",
        settingsGlyphs.notifications,
        WEB || window.cerium?.notify !== undefined,
      ),
      ...page("keyboard", "Keyboard", "Send key and shortcuts", settingsGlyphs.keyboard),
      ...page("dictation", "Dictation", "Language and speech model", settingsGlyphs.dictation, desktop),
      ...page(
        "updates",
        "Updates",
        "Version and channel",
        settingsGlyphs.updates,
        desktop && shellBridge()?.updates !== undefined,
      ),
    ],
  },
  {
    label: "Agents",
    pages: [
      ...page("threads", "New threads", "Model, effort and access", settingsGlyphs.threads),
      ...page("roster", "Roster", "Models a lead may start", settingsGlyphs.roster),
      ...page("advisor", "Advisor", "Experimental second opinion", settingsGlyphs.advisor),
      ...page("prompts", "Prompts", "Text and commands on /", settingsGlyphs.prompts),
      ...page("effortRouter", "Effort router", "Effort picked per turn", settingsGlyphs.router),
    ],
  },
  {
    label: "Providers",
    pages: [
      ...page("harnesses", "Harnesses", "Installed CLIs and sign-ins", settingsGlyphs.harnesses),
      ...page("mcp", "MCP servers", "Servers across harnesses", settingsGlyphs.mcp),
      ...page("skills", "Skills", "Skills across harnesses", settingsGlyphs.skills),
      ...page("usage", "Usage", "Limits and spend", settingsGlyphs.usage),
    ],
  },
  {
    label: "Integrations",
    pages: [
      ...page(
        "sourceControl",
        "Git & GitHub",
        "GitHub CLI and project scripts",
        settingsGlyphs.sourceControl,
      ),
      ...page("discord", "Discord", "Activity status", settingsGlyphs.discord, desktop),
      ...page("assistants", "Remote MCP", "Manage threads from other apps", settingsGlyphs.assistants),
    ],
  },
  {
    label: "Account",
    pages: [
      ...page("account", "Sign-in", "Your Cerium account", settingsGlyphs.account),
      ...page("devices", "Devices", "Where you're signed in", settingsGlyphs.devices),
    ],
  },
];

/** Every page in the sidebar's order, which the arrow keys step through. */
const pages = groups.flatMap((group) => group.pages);

const groupOf = (id: SettingsCategory) => groups.find((group) => group.pages.some((each) => each.id === id));

/** Every setting by name, with the page that holds it, for the sidebar's search. */
const settingsIndex: ReadonlyArray<{ readonly name: string; readonly category: SettingsCategory }> = (
  [
    ["general", "Start with Windows"],
    ["general", "Open at login"],
    ["general", "Slim old threads"],
    ["general", "Send crash reports"],
    ["general", "Welcome tour"],
    ["appearance", "Theme"],
    ["appearance", "Light or dark mode"],
    ["appearance", "Conversation text size"],
    ["appearance", "Window scale"],
    ["appearance", "Window opacity"],
    ["notifications", "Show notifications"],
    ["notifications", "Play a sound"],
    ["notifications", "Count on the taskbar"],
    ["notifications", "Notify me when"],
    ["keyboard", "Send messages with"],
    ["keyboard", "Shortcuts"],
    ["dictation", "Dictation language"],
    ["dictation", "Speech model"],
    ["updates", "Check for updates"],
    ["updates", "Update channel"],
    ["updates", "Download automatically"],
    ["updates", "What's new"],
    ["threads", "Default model"],
    ["threads", "Reasoning effort"],
    ["threads", "Access"],
    ["threads", "Where new work threads run"],
    ["threads", "Name new threads"],
    ["roster", "Roster"],
    ["advisor", "Advisor"],
    ["advisor", "Advisor model"],
    ["prompts", "Saved prompts"],
    ["effortRouter", "Pick effort automatically"],
    ["effortRouter", "OpenRouter key"],
    ["harnesses", "Installed CLIs"],
    ["harnesses", "Sign-ins"],
    ["mcp", "MCP servers"],
    ["mcp", "Server tools"],
    ["mcp", "Add a server to another harness"],
    ["skills", "Skills"],
    ["skills", "Add a skill to another harness"],
    ["usage", "Limits"],
    ["usage", "Tokens & cost"],
    ["usage", "Free resets"],
    ["sourceControl", "GitHub CLI"],
    ["sourceControl", "Project scripts"],
    ["discord", "Show activity on Discord"],
    ["assistants", "Allow remote MCP"],
    ["assistants", "MCP server address"],
    ["assistants", "Connected apps"],
    ["account", "Sign in"],
    ["account", "Sign out"],
    ["devices", "Devices"],
    ["devices", "Device name"],
  ] as const
)
  .map(([category, name]) => ({ category, name }))
  .filter(({ category }) => pages.some((each) => each.id === category));

/** The pages this window offers, which the command palette lists to jump to, each with its heading. */
export const settingsPages: ReadonlyArray<Page & { readonly group: string }> = groups.flatMap((group) =>
  group.pages.map((each) => ({ ...each, group: group.label })),
);

/** A page's name, as the narrow window's top bar shows it over the page. */
export const settingsLabel = (category: SettingsCategory) =>
  pages.find((each) => each.id === category)?.label ?? "Settings";

interface SettingsNavProps {
  readonly category: SettingsCategory;
  readonly onSelect: (category: SettingsCategory) => void;
  /** Settings are showing: the current page takes focus, ready for the arrow keys. */
  readonly active: boolean;
  /**
   * The narrow window's list of pages, each opening its page; its top bar has the way back.
   * Keyboard shortcuts are left out: a phone has no keyboard to speak of.
   */
  readonly compact?: boolean;
}

/** The sidebar while settings are open: the search, and the pages under their headings. */
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

  // Arrow keys move between pages, across the headings, like a list of tabs; Home and End jump to either end.
  const index = pages.findIndex((each) => each.id === category);
  const target: Record<string, number> = {
    ArrowDown: (index + 1) % pages.length,
    ArrowUp: (index - 1 + pages.length) % pages.length,
    Home: 0,
    End: pages.length - 1,
  };

  if (compact) {
    return (
      <nav aria-label="Settings" className="flex flex-col gap-5 px-3 pt-2 pb-6">
        {groups.map((group) => {
          const shown = group.pages.filter(({ id }) => id !== "keyboard");
          if (shown.length === 0) return null;
          return (
            <section key={group.label} className="flex flex-col gap-1.5">
              <h3 className="px-3 text-meta font-medium text-fg-tertiary">{group.label}</h3>
              <div className="flex flex-col divide-y divide-line-subtle overflow-hidden rounded-xl bg-surface-raised">
                {shown.map(({ id, label, description, icon: Icon }) => (
                  <Button
                    key={id}
                    onClick={() => onSelect(id)}
                    className="flex min-h-13 items-center gap-3 px-3 py-2 text-left transition-colors active:bg-surface-active"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-window text-fg-secondary">
                      <Icon size={18} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-reading text-fg-primary">{label}</span>
                      <span className="truncate text-meta text-fg-tertiary">{description}</span>
                    </span>
                    <ChevronRight size={16} strokeWidth={1.75} className="text-fg-tertiary" />
                  </Button>
                ))}
              </div>
            </section>
          );
        })}
      </nav>
    );
  }

  const needle = query.trim().toLowerCase();
  const hits =
    needle === ""
      ? []
      : settingsIndex.filter(
          ({ name, category: id }) =>
            name.toLowerCase().includes(needle) || settingsLabel(id).toLowerCase().includes(needle),
        );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-2 pl-3.5">
        <h2 className="text-reading font-semibold text-fg-primary max-md:text-base">Settings</h2>
      </div>
      <div className="mx-2 mb-3 overflow-hidden rounded-lg border border-line-subtle bg-surface-sunken [&>div]:h-8 [&>div]:border-b-0 [&>div]:pl-2.5">
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
              const Icon = pages.find((each) => each.id === id)?.icon ?? settingsGlyphs.general;
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
                  <span className="shrink-0 text-meta text-fg-tertiary">{settingsLabel(id)}</span>
                </Button>
              );
            })
          )}
        </div>
      ) : null}
      <nav
        ref={nav}
        aria-label="Settings"
        className={`relative isolate flex-col gap-3.5 overflow-y-auto px-2 pb-4 ${needle === "" ? "flex" : "hidden"}`}
      >
        <SlidingHighlight within={nav} active={category} className="rounded-md bg-surface-selected" />
        {groups.map((group) =>
          group.pages.length === 0 ? null : (
            <div key={group.label} className="flex flex-col gap-px">
              <h3 className="flex h-6 items-center px-2 text-meta text-fg-tertiary">{group.label}</h3>
              {group.pages.map(({ id, label, icon: Icon }) => (
                <Button
                  key={id}
                  ref={id === category ? current : undefined}
                  {...(id === category ? { "data-highlight-active": "" } : {})}
                  onClick={() => onSelect(id)}
                  onKeyDown={(event) => {
                    const next = pages[target[event.key] ?? -1];
                    if (next === undefined) return;
                    event.preventDefault();
                    onSelect(next.id);
                  }}
                  // One stop for Tab: the open page, from which the arrow keys move.
                  tabIndex={id === category ? 0 : -1}
                  aria-current={id === category ? "page" : undefined}
                  // The ring is a hairline inside the row: the open page's row is already highlighted, and a
                  // full ring around that read as a heavy white box when settings took focus on opening.
                  className={`flex h-7.5 items-center gap-2.5 rounded-md px-2 text-left text-body transition-colors duration-150 focus-visible:outline-1 focus-visible:-outline-offset-1 ${
                    id === category
                      ? "text-fg-primary"
                      : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
                  }`}
                >
                  <Icon size={16} className={id === category ? "text-fg-primary" : "text-fg-tertiary"} />
                  {label}
                </Button>
              ))}
            </div>
          ),
        )}
      </nav>
    </div>
  );
}

/** The open page, filling the main panel. */
export function SettingsView({
  category,
  harnesses,
  onOpen,
  project,
}: {
  category: SettingsCategory;
  /** Which harnesses can run, for the choices that depend on them. */
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Opens another page, for a page that points the way to one. */
  onOpen?: (category: SettingsCategory) => void;
  /** The folder of the thread Settings was opened from, which the pages about a project open on. */
  project?: string | undefined;
}) {
  return (
    <SettingsPlace value={groupOf(category)?.label}>
      <SettingsProject value={project}>
        <SettingsContent
          key={category}
          category={category}
          harnesses={harnesses}
          {...(onOpen ? { onOpen } : {})}
        />
      </SettingsProject>
    </SettingsPlace>
  );
}

function SettingsContent({
  category,
  harnesses,
  onOpen,
}: {
  category: SettingsCategory;
  harnesses: ReadonlyArray<HarnessIndicator>;
  onOpen?: (category: SettingsCategory) => void;
}) {
  const open = (to: SettingsCategory) => (onOpen ? { onOpen: () => onOpen(to) } : {});
  switch (category) {
    case "general":
      return <GeneralSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "notifications":
      return <NotificationSettings />;
    case "keyboard":
      return <KeyboardSettings />;
    case "dictation":
      return <DictationSettings />;
    case "updates":
      return <UpdateSettings />;
    case "threads":
      return <ThreadSettings harnesses={harnesses} {...open("harnesses")} />;
    case "roster":
      return <RosterSettings harnesses={harnesses} {...open("harnesses")} />;
    case "advisor":
      return <AdvisorSettings harnesses={harnesses} />;
    case "prompts":
      return <PromptSettings />;
    case "effortRouter":
      return <EffortRouterSettings />;
    case "harnesses":
      return <HarnessSettings />;
    case "mcp":
      return <McpSettings />;
    case "skills":
      return <SkillsSettings />;
    case "usage":
      return <UsageSettings {...(onOpen ? { onOpenHarnesses: () => onOpen("harnesses") } : {})} />;
    case "sourceControl":
      return <SourceControlSettings />;
    case "discord":
      return <DiscordSettings />;
    case "assistants":
      return <AssistantSettings {...open("account")} />;
    case "account":
      return <AccountSettings />;
    case "devices":
      return <DeviceSettings {...open("account")} />;
  }
}
