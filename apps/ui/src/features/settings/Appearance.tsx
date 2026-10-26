import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useAtom } from "@effect/atom-react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { keyLabel } from "../../lib/keys.ts";
import { useShortcut } from "../../lib/shortcuts.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { paletteAtom, palettes, type Palette } from "./palettes.ts";
import { SettingsList, SettingsPage, SettingsRow, SettingsSection } from "./parts.tsx";
import { scaleAtom, scales, textSizeAtom, textSizes, themeAtom, themes, type Theme } from "./preferences.ts";
import { canScale } from "./scale.ts";
import { useShownTheme } from "./theme.ts";

const modes: Record<Theme, { label: string; icon: LucideIcon }> = {
  system: { label: "System", icon: Monitor },
  dark: { label: "Dark", icon: Moon },
  light: { label: "Light", icon: Sun },
};

export function AppearanceSettings() {
  const [palette, setPalette] = useAtom(paletteAtom);
  const shown = useShownTheme();
  return (
    <SettingsPage title="Appearance">
      <SettingsSection title="Theme" action={<ModePicker />}>
        <RadioGroup
          value={palette}
          onValueChange={(value) => setPalette(value as Palette)}
          aria-label="Theme"
          className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3"
        >
          {palettes.map((option) => (
            <Radio.Root
              key={option.id}
              value={option.id}
              nativeButton
              render={<button type="button" aria-label={option.label} />}
              className="group flex flex-col gap-2.5 rounded-xl text-left outline-none"
            >
              <span className="relative block aspect-[16/10] overflow-hidden rounded-xl ring-1 ring-line-strong transition-[box-shadow] duration-150 group-hover:ring-fg-tertiary group-focus-visible:ring-2 group-focus-visible:ring-focus-ring group-data-checked:ring-2 group-data-checked:ring-accent">
                <WindowSample palette={option.id} theme={shown} />
              </span>
              <span className="flex items-center gap-2 px-0.5 text-body text-fg-secondary group-data-checked:font-medium group-data-checked:text-fg-primary">
                <span className="grid size-3.5 place-items-center rounded-full border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent">
                  <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
                </span>
                {option.label}
              </span>
            </Radio.Root>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection title="Size">
        <SettingsList>
          <TextSizeRow />
          {canScale() ? <ScaleRow /> : null}
        </SettingsList>
      </SettingsSection>
    </SettingsPage>
  );
}

/** Light, dark, or whichever the system is in: every theme has both. */
function ModePicker() {
  const [theme, setTheme] = useAtom(themeAtom);
  return (
    <RadioGroup
      value={theme}
      onValueChange={(value) => setTheme(value as Theme)}
      aria-label="Mode"
      className="flex shrink-0 rounded-lg border border-line-subtle bg-surface-hover p-0.5"
    >
      {themes.map((option) => {
        const { label, icon: Icon } = modes[option];
        return (
          <Radio.Root
            key={option}
            value={option}
            nativeButton
            render={<button type="button" aria-label={label} />}
            className="flex h-6.5 items-center gap-1.5 rounded-md px-2.5 text-meta text-fg-tertiary outline-none transition-colors duration-150 hover:text-fg-secondary focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:bg-surface-raised data-checked:text-fg-primary data-checked:shadow-raised"
          >
            <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
            {label}
          </Radio.Root>
        );
      })}
    </RadioGroup>
  );
}

/** The conversation's text size; the rest of the window keeps its own. */
function TextSizeRow() {
  const [textSize, setTextSize] = useAtom(textSizeAtom);
  const current = textSizes.find((size) => size.id === textSize);
  return (
    <SettingsRow
      label="Conversation text"
      hint="Messages, tool calls and approvals"
      className="pr-2.5"
      control={() => (
        <SelectRoot value={textSize} onValueChange={(next) => next !== null && setTextSize(next)}>
          <SelectTrigger label="Conversation text size">
            <span className="font-medium text-fg-primary">{current?.label}</span>
            <span className="text-fg-tertiary tabular-nums">{current?.px}px</span>
          </SelectTrigger>
          <SelectPopup>
            {textSizes.map((size) => (
              <SelectItem key={size.id} value={size.id} description={`${size.px}px`}>
                {size.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </SelectRoot>
      )}
    />
  );
}

/** The whole window's size, which Ctrl + and Ctrl − also step through. */
function ScaleRow() {
  const [scale, setScale] = useAtom(scaleAtom);
  return (
    <SettingsRow
      label="Window scale"
      hint={`${keyLabel(useShortcut("zoom-in"))} and ${keyLabel(useShortcut("zoom-out"))} change it from anywhere`}
      className="pr-2.5"
      control={() => (
        <SelectRoot
          value={String(scale)}
          onValueChange={(next) => setScale(scales.find((each) => String(each) === next) ?? 100)}
        >
          <SelectTrigger label="Window scale">
            <span className="font-medium text-fg-primary tabular-nums">{scale}%</span>
          </SelectTrigger>
          <SelectPopup>
            {scales.map((each) => (
              <SelectItem key={each} value={String(each)}>
                {`${each}%`}
              </SelectItem>
            ))}
          </SelectPopup>
        </SelectRoot>
      )}
    />
  );
}

/**
 * A miniature of Cerium's window drawn with the given palette's own tokens in the given mode: the
 * glass, the sidebar and the conversation panel with a message, a line of code in the palette's
 * colours, and the composer with its accent.
 */
function WindowSample({ palette, theme }: { palette: Palette; theme: "dark" | "light" }) {
  return (
    <span data-palette={palette} data-theme={theme} className="absolute inset-0 block bg-backdrop p-2.5 pb-0">
      <span className="flex h-full flex-col overflow-hidden rounded-t-md border border-b-0 border-line-strong bg-surface-window shadow-overlay">
        <span className="flex h-3.5 shrink-0 items-center gap-1 px-1.5">
          <span className="size-1.5 rounded-full bg-fg-primary" />
          <span className="h-1 w-5 rounded-full bg-fg-tertiary/60" />
        </span>
        <span className="flex min-h-0 flex-1 gap-1 pr-1">
          <span className="flex w-[30%] flex-col gap-1 px-1 pt-0.5">
            <span className="mb-0.5 h-2.5 rounded-sm border border-line-subtle bg-surface-raised" />
            <span className="h-1 w-3/4 rounded-full bg-fg-tertiary/45" />
            <span className="flex h-2.5 items-center rounded-sm bg-surface-selected px-0.5">
              <span className="h-1 w-4/5 rounded-full bg-fg-secondary/70" />
            </span>
            <span className="h-1 w-2/3 rounded-full bg-fg-tertiary/45" />
            <span className="h-1 w-4/5 rounded-full bg-fg-tertiary/45" />
          </span>
          <span className="flex flex-1 flex-col gap-1 rounded-t-[5px] border border-b-0 border-line-subtle bg-surface-panel p-1.5">
            <span className="h-3 w-1/2 self-end rounded-[3px] border border-line-subtle bg-surface-raised" />
            <span className="mt-0.5 h-1 w-[88%] rounded-full bg-fg-primary/55" />
            <span className="h-1 w-[72%] rounded-full bg-fg-primary/55" />
            <span className="mt-0.5 flex gap-[3px] rounded-[3px] bg-surface-hover p-1">
              <span className="h-1 w-[18%] rounded-full bg-(--syntax-keyword)" />
              <span className="h-1 w-[26%] rounded-full bg-(--syntax-function)" />
              <span className="h-1 w-[34%] rounded-full bg-(--syntax-string)" />
              <span className="h-1 w-[12%] rounded-full bg-(--syntax-constant)" />
            </span>
            <span className="mx-1 mt-auto mb-1.5 flex h-4 items-center justify-end rounded-[5px] border border-line-subtle bg-surface-raised px-0.5">
              <span className="size-2.5 rounded-full bg-accent" />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}
