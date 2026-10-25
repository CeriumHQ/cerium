import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";

import { Tooltip } from "../components/ui/Tooltip.tsx";

export type AppMode = "work" | "chat";

const modes = [
  { value: "work", label: "Work", shortcut: "Ctrl Shift 1" },
  { value: "chat", label: "Chat", shortcut: "Ctrl Shift 2" },
] as const;

/**
 * Switches the whole window between work threads (agents on a folder) and chats, at the top of the
 * sidebar: two even halves of a sunken track, the active one raised like the button under it. The
 * weight stays the same in both states, so switching never nudges the labels.
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
      className="grid grid-cols-2 gap-0.5 rounded-lg border border-line-subtle p-0.5"
    >
      {modes.map(({ value, label, shortcut }) => (
        <Tooltip key={value} label={label} shortcut={shortcut}>
          <Toggle
            value={value}
            className="h-7 rounded-md text-[13px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:h-9 max-md:text-[15px]"
          >
            {label}
          </Toggle>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
