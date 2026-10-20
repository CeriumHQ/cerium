import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Slider } from "@base-ui/react/slider";
import { useAtom } from "@effect/atom-react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { UserMessage } from "../transcript/Blocks.tsx";
import { Markdown } from "../transcript/Markdown.tsx";
import type { TranscriptBlock } from "../transcript/model.ts";
import { ToolGroup } from "../transcript/ToolGroup.tsx";
import { ResponseHeader } from "../transcript/Transcript.tsx";
import { paletteAtom, palettes, type Palette } from "./palettes.ts";
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";
import {
  scaleAtom,
  scales,
  textScale,
  textSizeAtom,
  textSizes,
  themeAtom,
  themes,
  type Theme,
} from "./preferences.ts";
import { canScale } from "./scale.ts";
import { useShownTheme } from "./theme.ts";

const modes: Record<Theme, { label: string; icon: LucideIcon }> = {
  system: { label: "System", icon: Monitor },
  dark: { label: "Dark", icon: Moon },
  light: { label: "Light", icon: Sun },
};

export function AppearanceSettings() {
  const [palette, setPalette] = useAtom(paletteAtom);
  const [textSize, setTextSize] = useAtom(textSizeAtom);
  const shown = useShownTheme();
  return (
    <SettingsPage title="Appearance">
      <SettingsSection
        title="Theme"
        info="Every theme comes in light and dark. System follows Windows."
        action={<ModePicker />}
      >
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
              <span className="flex items-center gap-2 px-0.5 text-[13px] text-fg-secondary group-data-checked:font-medium group-data-checked:text-fg-primary">
                <span className="grid size-3.5 place-items-center rounded-full border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent">
                  <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
                </span>
                {option.label}
              </span>
            </Radio.Root>
          ))}
        </RadioGroup>
      </SettingsSection>

      {canScale() ? <ScaleSection /> : null}

      <SettingsSection
        title="Conversation text"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            Scales messages, tool calls and approvals.
            <InfoTip label="About conversation text">The rest of the window keeps its size.</InfoTip>
          </span>
        }
      >
        <TextSizeSlider
          value={textSize}
          onChange={(index) => setTextSize(textSizes[index]?.id ?? "default")}
        />
        <ConversationSample scale={textScale(textSize)} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** Light, dark, or whichever Windows is in: every theme has both. */
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
            className="flex h-6.5 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-fg-tertiary outline-none transition-colors duration-150 hover:text-fg-secondary focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:bg-surface-raised data-checked:text-fg-primary data-checked:shadow-raised"
          >
            <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
            {label}
          </Radio.Root>
        );
      })}
    </RadioGroup>
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

function TextSizeSlider({ value, onChange }: { value: string; onChange: (index: number) => void }) {
  const index = textSizes.findIndex((size) => size.id === value);
  return (
    <StepSlider
      label="Conversation text size"
      stops={textSizes.length}
      index={index}
      onChange={onChange}
      valueText={(at) => textSizes[at]?.label ?? ""}
      readout={
        <>
          {textSizes[index]?.label} <span className="text-fg-tertiary">· {textSizes[index]?.px}px</span>
        </>
      }
    />
  );
}

/** The whole window's size, Ctrl + and Ctrl − included; a way back to 100% once it's changed. */
function ScaleSection() {
  const [scale, setScale] = useAtom(scaleAtom);
  return (
    <SettingsSection
      title="Scale"
      description={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          Sizes the whole window.
          <InfoTip label="About scale">
            Ctrl + and Ctrl − change it from anywhere; Ctrl 0 on the numpad goes back to 100%.
          </InfoTip>
        </span>
      }
      action={
        scale === 100 ? undefined : (
          <button
            type="button"
            onClick={() => setScale(100)}
            className="flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors outline-none hover:bg-surface-hover hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Reset to 100%
          </button>
        )
      }
    >
      <StepSlider
        label="Window scale"
        stops={scales.length}
        index={scales.indexOf(scale)}
        onChange={(index) => setScale(scales[index] ?? 100)}
        valueText={(at) => `${scales[at] ?? 100}%`}
        readout={`${scale}%`}
      />
    </SettingsSection>
  );
}

/** A slider that snaps to `stops` evenly spaced stops, each marked on its track. */
function StepSlider({
  label,
  stops,
  index,
  onChange,
  valueText,
  readout,
}: {
  label: string;
  stops: number;
  index: number;
  onChange: (index: number) => void;
  valueText: (index: number) => string;
  readout: ReactNode;
}) {
  const last = stops - 1;
  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" className="w-4 text-center text-[12px] font-medium text-fg-tertiary">
        A
      </span>
      <Slider.Root
        value={index}
        onValueChange={(next) => onChange(Array.isArray(next) ? (next[0] ?? 1) : next)}
        min={0}
        max={last}
        step={1}
        className="flex-1"
      >
        <Slider.Control className="flex h-6 touch-none items-center select-none">
          <Slider.Track className="relative h-1 w-full rounded-full bg-line-strong">
            <Slider.Indicator className="rounded-full bg-fg-secondary" />
            {Array.from({ length: stops }, (_, mark) => (
              <span
                key={mark}
                aria-hidden="true"
                className={`absolute top-1/2 size-1.5 -translate-1/2 rounded-full ${
                  mark <= index ? "bg-fg-secondary" : "bg-fg-disabled"
                }`}
                style={{ left: `${(mark / last) * 100}%` }}
              />
            ))}
            <Slider.Thumb
              aria-label={label}
              getAriaValueText={(_formatted, at) => valueText(at)}
              className="size-4 rounded-full bg-accent shadow-raised outline-none transition-[scale] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface-panel data-dragging:scale-110"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span aria-hidden="true" className="w-4 text-center text-[17px] font-medium text-fg-tertiary">
        A
      </span>
      <span className="w-24 text-right text-[12.5px] text-fg-secondary tabular-nums">{readout}</span>
    </div>
  );
}

const sampleTools: ReadonlyArray<Extract<TranscriptBlock, { kind: "tool" }>> = [
  {
    kind: "tool",
    id: "sample:read",
    toolName: "Read",
    input: { file_path: "src/greet.ts" },
    status: "done",
    changedFiles: [],
  },
  {
    kind: "tool",
    id: "sample:edit",
    toolName: "Edit",
    input: { file_path: "src/greet.ts", old_string: "greet", new_string: "welcome" },
    status: "done",
    changedFiles: ["src/greet.ts"],
  },
];

/** A few lines of conversation at the chosen size, drawn by the transcript's own components. */
function ConversationSample({ scale }: { scale: number }) {
  return (
    <SettingsCard className="relative h-64 overflow-hidden bg-surface-window/40">
      <div
        aria-hidden="true"
        inert
        className="h-full mask-b-from-[calc(100%-3rem)] px-6 pt-5"
        style={{ zoom: scale }}
      >
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <UserMessage
              block={{
                kind: "user",
                id: "sample:user",
                text: "Rename `greet` to `welcome`.",
                attachments: [],
                mentions: [],
              }}
            />
          </div>
          <ResponseHeader agent={{ provider: "claude", model: "Opus 5.5" }} />
          <ToolGroup tools={sampleTools} activity="idle" />
          <Markdown
            streaming={false}
            text={
              "Renamed `greet` to `welcome` in **src/greet.ts**. Nothing else called it, so no other files changed."
            }
          />
        </div>
      </div>
    </SettingsCard>
  );
}
