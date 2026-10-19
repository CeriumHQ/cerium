import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";

import { Tooltip } from "../components/ui/Tooltip.tsx";

export type AppMode = "work" | "chat";

const modes = [
  { value: "work", label: "Work", shortcut: "Ctrl 1" },
  { value: "chat", label: "Chat", shortcut: "Ctrl 2" },
] as const;

/**
 * Switches the whole window between work threads (agents on a folder) and chats. Deliberately quiet:
 * two labels, the active one brighter on a faint pill. The weight stays the same in both states, so
 * switching never nudges its neighbours.
 */
export function ModeSwitch({ mode, onChange }: { mode: AppMode; onChange: (mode: AppMode) => void }) {
  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "work" || next === "chat") onChange(next);
      }}
      aria-label="Mode"
      className="flex items-center [app-region:no-drag]"
    >
      {modes.map(({ value, label, shortcut }) => (
        <Tooltip key={value} label={label} shortcut={shortcut}>
          <Toggle
            value={value}
            className="rounded-md px-2 py-0.5 text-[13px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[15px]"
          >
            {label}
          </Toggle>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
