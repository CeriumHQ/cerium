import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Slider } from "@base-ui/react/slider";
import { Switch } from "@base-ui/react/switch";
import type { AccessMode, HarnessLimit, ReasoningEffort } from "@cerium/protocol";
import {
  Eye,
  FilePen,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { SelectItem, SelectPopup, SelectRoot, triggerClass } from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { accessOptions, effortLabel } from "./models.ts";

// The pickers in the message box's toolbar beside the model menu (ModelPicker.tsx). A new thread
// picks all of them; an open thread's lead can pick its effort again, when its harness allows it.

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

/** How much each mode lets agents do unasked, coloured on the access pill's shield. */
const accessTone: Record<AccessMode, string> = {
  readOnly: "text-fg-tertiary",
  ask: "text-fg-tertiary",
  acceptEdits: "text-fg-tertiary",
  auto: "text-success",
  fullAccess: "text-attention",
};

/** The model and its effort, set into the box together; the effort is absent for models without one. */
export function ModelWell({ model, effort }: { readonly model: ReactNode; readonly effort?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center rounded-[9px] border border-line-subtle bg-surface-sunken px-px">
      {model}
      {effort ? (
        <>
          <span aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-line-strong" />
          {effort}
        </>
      ) : null}
    </div>
  );
}

/** The effort heat's colour `at` (0 to 1) along its gradient, cool to hot (styles/tokens.css). */
const heat = (at: number): string =>
  at <= 0.5
    ? `color-mix(in oklab, var(--effort-warm) ${at * 200}%, var(--effort-cool))`
    : `color-mix(in oklab, var(--effort-hot) ${(at - 0.5) * 200}%, var(--effort-warm))`;

/** A bar for each effort the model offers, rising and warming, lit up to the one it runs at. */
export function EffortMeter({
  efforts,
  level,
}: {
  readonly efforts: ReadonlyArray<ReasoningEffort>;
  /** The lit bar's index in `efforts`. */
  readonly level: number;
}) {
  const rises = Math.max(1, efforts.length - 1);
  return (
    <span aria-hidden className="flex h-3 shrink-0 items-end gap-0.5">
      {efforts.map((effort, index) => (
        <span
          key={effort}
          className="w-[3px] rounded-[1px] transition-[background-color] duration-150"
          style={{
            height: `${4 + (8 * index) / rises}px`,
            backgroundColor: index <= level ? heat(index / rises) : "var(--line-strong)",
          }}
        />
      ))}
    </span>
  );
}

/** The efforts named under the slider's stops, short enough for six of them to sit side by side. */
const shortEffortLabel: Record<ReasoningEffort, string> = { ...effortLabel, xhigh: "X-high" };

/** The slider's thumb, in pixels: its stops sit where the thumb's centre lands. */
const THUMB = 18;

/**
 * Picks among the efforts the model, or the models, offer: a meter that opens a slider with a stop
 * for each of them. A model with one effort has nothing to pick, and shows it. With `auto`, the
 * effort router is on and a switch under the slider hands it the pick; picking a level takes it back.
 */
export function EffortPicker({
  efforts,
  value,
  onPick,
  auto,
}: {
  readonly efforts: ReadonlyArray<ReasoningEffort>;
  readonly value: ReasoningEffort;
  readonly onPick: (effort: ReasoningEffort) => void;
  readonly auto?: { readonly on: boolean; readonly onChange: (on: boolean) => void } | undefined;
}) {
  /** The stop a drag is on, shown at once and picked only as the drag ends. */
  const [held, setHeld] = useState<number>();
  const thumb = useRef<HTMLInputElement>(null);
  const autoLabel = useId();
  const last = efforts.length - 1;
  const index = held ?? Math.max(0, efforts.indexOf(value));
  const label = effortLabel[efforts[index] ?? value];
  const automatic = auto?.on === true && held === undefined;
  /** Where a stop sits along the track: where the thumb's centre lands on it. */
  const at = (stop: number) => `calc(${THUMB / 2}px + ${stop / last} * (100% - ${THUMB}px))`;
  if (last < 1) {
    return <span className="flex h-7 shrink-0 items-center px-2 text-[12px] text-fg-tertiary">{label}</span>;
  }
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) setHeld(undefined);
      }}
    >
      <Popover.Trigger
        aria-label={automatic ? `Reasoning effort: Auto, ${label} now` : `Reasoning effort: ${label}`}
        className={`${triggerClass} gap-2`}
      >
        <EffortMeter efforts={efforts} level={index} />
        <span className="text-[12px]">{automatic ? "Auto" : label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50 outline-none">
          <Popover.Popup
            initialFocus={thumb}
            className="w-68 origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay px-3.5 pt-3 pb-2.5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <Popover.Title className="text-[12px] font-normal text-fg-tertiary">
                Reasoning effort
              </Popover.Title>
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <EffortMeter efforts={efforts} level={index} />
                {automatic ? <span className="font-normal text-fg-tertiary">Auto ·</span> : null}
                {label}
              </span>
            </div>
            <Slider.Root
              value={index}
              min={0}
              max={last}
              largeStep={1}
              thumbAlignment="edge"
              onValueChange={(next) => setHeld(next)}
              onValueCommitted={(next) => {
                setHeld(undefined);
                const picked = efforts[next];
                // On Auto, picking even the level it's at takes the pick back.
                if (picked !== undefined && (picked !== value || auto?.on)) onPick(picked);
              }}
            >
              <Slider.Control className="flex h-6 w-full cursor-pointer touch-none items-center select-none">
                <Slider.Track className="relative h-2 w-full rounded-full bg-surface-active">
                  {/* The whole heat, shown up to the thumb, so the fill warms as it grows; it glows in
                      the colour it reaches. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 transition-[filter] duration-150"
                    style={{ filter: `drop-shadow(0 0 5px ${heat(index / last)})` }}
                  >
                    <span
                      className={`absolute inset-0 rounded-full bg-(image:--effort-heat) ${held === undefined ? "transition-[clip-path] duration-200 ease-out-soft" : ""}`}
                      style={{ clipPath: `inset(0 calc(100% - ${at(index)}) 0 0 round 9999px)` }}
                    />
                  </span>
                  {efforts.map((level, stop) => (
                    <span
                      key={level}
                      aria-hidden
                      className={`pointer-events-none absolute top-1/2 size-1 -translate-1/2 rounded-full ${
                        stop <= index ? "bg-surface-overlay/70" : "bg-fg-disabled"
                      }`}
                      style={{ left: at(stop) }}
                    />
                  ))}
                  <Slider.Thumb
                    inputRef={thumb}
                    aria-label="Reasoning effort"
                    getAriaValueText={(_, stop) => effortLabel[efforts[stop] ?? value]}
                    className="size-4.5 rounded-full border-[3px] bg-fg-primary shadow-[0_0_0_2px_var(--surface-overlay)] transition-[scale,border-color] duration-150 has-focus-visible:outline-2 has-focus-visible:outline-offset-3 has-focus-visible:outline-focus-ring data-dragging:scale-110"
                    style={{ borderColor: heat(index / last) }}
                  />
                </Slider.Track>
              </Slider.Control>
            </Slider.Root>
            {/* Every stop by name, under its place on the track; a click picks it. */}
            <div className="relative mt-1.5 h-4">
              {efforts.map((level, stop) => (
                <button
                  key={level}
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    setHeld(undefined);
                    if (level !== value || auto?.on) onPick(level);
                  }}
                  className={`absolute top-0 -translate-x-1/2 text-2xs whitespace-nowrap transition-colors first:translate-x-0 last:-translate-x-full ${
                    stop === index
                      ? "font-medium text-fg-primary"
                      : "text-fg-tertiary hover:text-fg-secondary"
                  }`}
                  style={{
                    left: stop === 0 ? 0 : stop === last ? "100%" : at(stop),
                  }}
                >
                  {shortEffortLabel[level]}
                </button>
              ))}
            </div>
            {auto ? (
              <div className="-mx-3.5 mt-2.5 flex items-center gap-3 border-t border-line-subtle px-3.5 pt-2.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span id={autoLabel} className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    <Sparkles size={12} strokeWidth={2} className="text-fg-tertiary" />
                    Auto
                  </span>
                  <span className="text-2xs text-fg-tertiary">Picks the level for each turn</span>
                </span>
                <Switch.Root
                  checked={auto.on}
                  onCheckedChange={auto.onChange}
                  aria-labelledby={autoLabel}
                  className="relative flex h-4.5 w-8 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-200 ease-out-soft outline-none focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:bg-accent"
                >
                  <Switch.Thumb className="size-3.5 rounded-full bg-fg-primary shadow-raised transition-[translate,background-color] duration-200 ease-out-soft data-checked:translate-x-3.5 data-checked:bg-accent-fg" />
                </Switch.Root>
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What agents may do without asking; fixed once the thread starts. */
export function AccessPicker({
  value,
  onPick,
  limit,
}: {
  readonly value: AccessMode;
  readonly onPick: (access: AccessMode) => void;
  /** Modes a starting model's harness can't run here: offered disabled, with its reason. */
  readonly limit?: HarnessLimit | undefined;
}) {
  const Icon = accessIcon[value];
  return (
    <SelectRoot
      value={value}
      onValueChange={(access: AccessMode | null) => {
        if (access !== null) onPick(access);
      }}
    >
      <BaseSelect.Trigger
        aria-label="Access"
        className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line-subtle pr-2.5 pl-2 text-[12px] whitespace-nowrap text-fg-secondary transition-colors select-none hover:border-line-strong hover:text-fg-primary data-popup-open:border-line-strong data-popup-open:text-fg-primary"
      >
        <Icon size={12} strokeWidth={2} className={accessTone[value]} />
        {accessOptions.find((option) => option.value === value)?.label}
      </BaseSelect.Trigger>
      <SelectPopup>
        {accessOptions.map((option) => {
          const blocked = limit?.blocks.includes(option.value) === true;
          return (
            <SelectItem
              key={option.value}
              value={option.value}
              icon={accessIcon[option.value]}
              description={blocked ? limit?.reason : option.description}
              disabled={blocked}
            >
              {option.label}
            </SelectItem>
          );
        })}
      </SelectPopup>
    </SelectRoot>
  );
}

/** A setting the thread can't change any more: the same chip as its picker, without the list. */
export function FixedChip({
  tip,
  children,
}: {
  /** Why it can't change. */
  readonly tip: string;
  readonly children: ReactNode;
}) {
  // A disabled button that still takes focus, so the reason is there for the keyboard too.
  return (
    <Tooltip label={tip}>
      <Button
        disabled
        focusableWhenDisabled
        className="flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 text-[12.5px] whitespace-nowrap text-fg-tertiary"
      >
        {children}
      </Button>
    </Tooltip>
  );
}
