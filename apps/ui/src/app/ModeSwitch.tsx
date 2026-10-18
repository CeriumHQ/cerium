import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";

export type AppMode = "work" | "chat";

const modes = [
  { value: "work", label: "Work" },
  { value: "chat", label: "Chat" },
] as const;

/**
 * Switches the whole window between work threads (agents on a folder) and chats. Deliberately quiet:
 * two labels, the active one simply brighter.
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
      {modes.map(({ value, label }) => (
        <Toggle
          key={value}
          value={value}
          className="rounded-md px-1.5 py-0.5 text-[13px] text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:font-medium data-pressed:text-fg-primary max-md:px-2 max-md:py-1.5 max-md:text-[15px]"
        >
          {label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
