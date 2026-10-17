import { Button } from "@base-ui/react/button";
import { ArrowLeft, Bot, Palette, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { AgentSettings } from "./Agents.tsx";
import { AppearanceSettings } from "./Appearance.tsx";

export type SettingsCategory = "appearance" | "agents";

const categories: ReadonlyArray<{
  readonly id: SettingsCategory;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents", icon: Bot },
];

interface SettingsNavProps {
  readonly category: SettingsCategory;
  readonly onSelect: (category: SettingsCategory) => void;
  /** Where leaving settings goes back to. */
  readonly backLabel: string;
  readonly onBack: () => void;
  /** Settings are showing: the current category takes focus, ready for the arrow keys. */
  readonly active: boolean;
}

/** The sidebar while settings are open: the way back, and the categories. */
export function SettingsNav({ category, onSelect, backLabel, onBack, active }: SettingsNavProps) {
  const nav = useRef<HTMLElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) current.current?.focus();
  }, [active]);
  // Focus follows the selection when the arrow keys move it.
  useEffect(() => {
    if (nav.current?.contains(document.activeElement)) current.current?.focus();
  }, [category]);

  // Arrow keys move between categories, like a list of tabs.
  const step = (offset: number) => {
    const index = categories.findIndex((each) => each.id === category);
    const next = categories[(index + offset + categories.length) % categories.length];
    if (next) onSelect(next.id);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex px-2 pb-2">
        <Button
          onClick={onBack}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-line-subtle bg-surface-raised px-2.5 text-[13px] font-medium text-fg-primary shadow-raised transition-colors duration-150 hover:bg-surface-panel active:bg-surface-active"
        >
          <ArrowLeft size={14} strokeWidth={1.75} className="text-fg-secondary" />
          {backLabel}
          <kbd className="ml-auto font-sans text-2xs text-fg-tertiary">Esc</kbd>
        </Button>
      </div>

      <p className="px-4 pt-2 pb-1.5 text-xs font-medium text-fg-secondary/80">Settings</p>
      <nav ref={nav} aria-label="Settings" className="flex flex-col gap-px px-2">
        {categories.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            ref={id === category ? current : undefined}
            onClick={() => onSelect(id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              step(event.key === "ArrowDown" ? 1 : -1);
            }}
            aria-current={id === category ? "page" : undefined}
            className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
              id === category
                ? "bg-surface-selected font-medium text-fg-primary"
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
}: {
  category: SettingsCategory;
  /** Which harnesses can run, for the choices that depend on them. */
  harnesses: ReadonlyArray<HarnessIndicator>;
}) {
  switch (category) {
    case "appearance":
      return <AppearanceSettings key={category} />;
    case "agents":
      return <AgentSettings key={category} harnesses={harnesses} />;
  }
}
