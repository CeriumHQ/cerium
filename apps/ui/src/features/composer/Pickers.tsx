import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { AccessMode, HarnessLimit, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import {
  Eye,
  FilePen,
  Route,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { MenuRadioGroup, MenuRadioItem } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { accessOptions, effortHint, effortLabel, speedHint, speedLabel } from "./models.ts";

// The message box's own controls beside the model menu (ModelPicker.tsx): the effort, speed and
// several-at-once controls inside that menu, and the access menu beside it.

/** A control in the box's rows, without its colours: a pill, the box itself being one. */
const chipShape =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta whitespace-nowrap transition-colors select-none pointer-coarse:h-10 max-md:h-10";

/** A control in the box's rows: a quiet pill. */
export const chipClass = `${chipShape} text-fg-secondary hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-active data-popup-open:text-fg-primary`;

/**
 * Access the agents run with, on the chip that stands for it once it isn't Auto. Full access warns with
 * a dot rather than an amber fill: it's often left on, and a fill would outshout send all day.
 */
const accessChipTone: Partial<Record<AccessMode, string>> = {
  fullAccess:
    "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-active data-popup-open:text-fg-primary",
};

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

/** The effort a chip names: short enough to sit after the model's name. */
export const chipEffortLabel: Record<ReasoningEffort | "auto", string> = {
  ...effortLabel,
  xhigh: "X-high",
  auto: "Auto",
};

/** The effort row's labels on a phone, short enough for six levels to sit side by side. */
const segmentLabel: Record<ReasoningEffort, string> = {
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

/** How hard a model thinks, as a chip names it: a level, or Auto for the effort router to pick. */
export type EffortPick = ReasoningEffort | "auto";

/** What the model menu offers for the picked model's effort. */
export interface EffortChoice {
  /** The levels on offer, weakest first. */
  readonly levels: ReadonlyArray<ReasoningEffort>;
  /** The level picked; on Auto, the one a turn falls back to where the router can't decide. */
  readonly value: ReasoningEffort;
  readonly onPick: (effort: ReasoningEffort) => void;
  /** While the effort router is on: Auto, switched on and off beside the levels. */
  readonly auto?: { readonly on: boolean; readonly onToggle: (on: boolean) => void };
}

/** Whether there's anything to pick: a model with one level leaves nothing, Auto included. */
export const offersChoice = (choice: EffortChoice | undefined): choice is EffortChoice =>
  choice !== undefined && choice.levels.length > 1;

/** The menu's search keeps focus, so typing and the arrow keys carry on after a click. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** A section of the model menu's side panel: its name, its control, and what the pick trades. */
function TuneSection({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-2.5 pb-2 max-md:px-2.5">
      <span className="px-1.5 text-caption font-medium text-fg-tertiary select-none">{label}</span>
      {children}
      <span className="truncate px-1.5 text-caption text-fg-tertiary select-none">{hint}</span>
    </div>
  );
}

/** A level's place among the model's levels, as rising bars: the more filled, the harder it thinks. */
function EffortBars({ at, of }: { readonly at: number; readonly of: number }) {
  return (
    <span aria-hidden className="flex h-2.5 shrink-0 items-end gap-0.5 max-md:hidden">
      {Array.from({ length: of }, (_, bar) => (
        <span
          key={bar}
          className={`w-0.75 rounded-full bg-current ${bar <= at ? "" : "opacity-20"}`}
          style={{ height: `${35 + (65 * bar) / Math.max(1, of - 1)}%` }}
        />
      ))}
    </span>
  );
}

/** A row of the side panel's lists: one choice, picked or not. */
const tuneRow =
  "flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-meta whitespace-nowrap text-fg-secondary transition-colors select-none hover:bg-surface-hover hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-focus-ring max-md:h-9 max-md:flex-1 max-md:justify-center";

/**
 * How hard the picked model thinks, in the model menu's side panel: a level per row, weakest first,
 * each with bars that rise with it. Auto heads the list while the effort router is on; the picked
 * level then shows dashed, standing by for the turns the router can't decide.
 */
export function EffortLadder({ choice, model }: { readonly choice: EffortChoice; readonly model: string }) {
  const auto = choice.auto?.on === true;
  return (
    <TuneSection label="Effort" hint={effortHint[auto ? "auto" : choice.value]}>
      {/* A column beside the list; on a phone, one row under it, Auto first. */}
      <div className="flex flex-col gap-1.5 max-md:flex-row max-md:gap-1">
        {choice.auto ? (
          <Toggle
            pressed={auto}
            onPressedChange={choice.auto.onToggle}
            aria-label="Auto"
            onMouseDown={keepFocus}
            className={`${tuneRow} group/auto max-md:h-10 max-md:flex-none max-md:rounded-[9px] max-md:bg-surface-sunken max-md:px-3 max-md:text-fg-tertiary data-pressed:bg-surface-selected max-md:data-pressed:bg-accent max-md:data-pressed:text-accent-fg data-pressed:font-medium data-pressed:text-fg-primary`}
          >
            <span className="min-w-0 flex-1 truncate text-left max-md:flex-none">Auto</span>
            <Route
              size={12}
              strokeWidth={2}
              className="shrink-0 text-fg-tertiary group-data-pressed/auto:text-accent max-md:group-data-pressed/auto:text-accent-fg"
            />
          </Toggle>
        ) : null}
        <ToggleGroup
          value={[choice.value]}
          onValueChange={(value) => {
            const next = value[0] as ReasoningEffort | undefined;
            if (next !== undefined) choice.onPick(next);
          }}
          orientation="vertical"
          aria-label={auto ? `Effort for ${model} when Auto can't decide` : `Effort for ${model}`}
          className="flex flex-col gap-px max-md:min-w-0 max-md:flex-1 max-md:flex-row max-md:rounded-[9px] max-md:bg-surface-sunken max-md:p-0.5"
        >
          {choice.levels.map((level, at) => (
            <Toggle
              key={level}
              value={level}
              aria-label={chipEffortLabel[level]}
              onMouseDown={keepFocus}
              className={`${tuneRow} ${
                auto
                  ? "data-pressed:text-fg-primary data-pressed:outline-1 data-pressed:-outline-offset-1 data-pressed:outline-line-strong data-pressed:outline-dashed"
                  : "data-pressed:bg-surface-selected data-pressed:font-medium data-pressed:text-fg-primary"
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-left max-md:hidden">
                {chipEffortLabel[level]}
              </span>
              <span className="md:hidden">{segmentLabel[level]}</span>
              <EffortBars at={at} of={choice.levels.length} />
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </TuneSection>
  );
}

/** What the model menu offers for the picked model's speed. */
export interface SpeedChoice {
  /** The speeds on offer, slowest first. */
  readonly speeds: ReadonlyArray<ModelSpeed>;
  readonly value: ModelSpeed;
  readonly onPick: (speed: ModelSpeed) => void;
}

/** Whether there's a speed to pick: a model served at one speed leaves none. */
export const offersSpeed = (choice: SpeedChoice | undefined): choice is SpeedChoice =>
  choice !== undefined && choice.speeds.length > 1;

/**
 * A speed past standard, which costs more: a bolt, filled for the fastest. Nothing for standard, so
 * the chip stays quiet until speed costs something.
 */
export function SpeedMark({
  speed,
  size = 11,
}: {
  readonly speed: ModelSpeed | undefined;
  readonly size?: number;
}) {
  if (speed === undefined || speed === "standard") return null;
  return (
    <Zap
      size={size}
      strokeWidth={2}
      aria-label={speedLabel[speed]}
      className={`shrink-0 text-attention-text ${speed === "ultrafast" ? "fill-current" : ""}`}
    />
  );
}

/**
 * How fast the provider serves the picked model, at a higher price past standard: a segment per
 * speed under the effort, since it's seldom changed.
 */
export function SpeedSwitch({ choice, model }: { readonly choice: SpeedChoice; readonly model: string }) {
  return (
    <TuneSection label="Speed" hint={speedHint[choice.value]}>
      <ToggleGroup
        value={[choice.value]}
        onValueChange={(value) => {
          const next = value[0] as ModelSpeed | undefined;
          if (next !== undefined) choice.onPick(next);
        }}
        aria-label={`Speed for ${model}`}
        className="flex gap-0.5 rounded-[9px] bg-surface-sunken p-0.5"
      >
        {choice.speeds.map((speed) => (
          <Toggle
            key={speed}
            value={speed}
            aria-label={speedLabel[speed]}
            onMouseDown={keepFocus}
            className="flex h-6.5 min-w-0 flex-1 items-center justify-center gap-1 rounded-[7px] px-1.5 text-meta whitespace-nowrap text-fg-tertiary transition-colors select-none hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-focus-ring data-pressed:bg-surface-overlay data-pressed:font-medium data-pressed:text-fg-primary data-pressed:shadow-[0_0_0_1px_var(--line-strong)] max-md:h-9"
          >
            <SpeedMark speed={speed} />
            <span className="truncate">{speedLabel[speed]}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </TuneSection>
  );
}

/** Several models at once, a thread each: what the model menu's foot switches on and off. */
export interface SeveralChoice {
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}

/** The model menu's foot for a new thread: several models at once, with how many are picked while on. */
export function SeveralSwitch({
  choice,
  count,
}: {
  readonly choice: SeveralChoice;
  /** How many are picked, and how many may be. */
  readonly count?: { readonly picked: number; readonly max: number } | undefined;
}) {
  // The whole row is the switch, so a click anywhere on it flips it.
  return (
    <Switch.Root
      checked={choice.on}
      onCheckedChange={choice.onChange}
      onMouseDown={keepFocus}
      className="group/several flex h-9 w-full shrink-0 cursor-default items-center gap-2 border-t border-line-subtle px-3 text-meta text-fg-secondary transition-colors outline-none select-none hover:bg-surface-hover hover:text-fg-primary focus-visible:bg-surface-hover max-md:h-11"
    >
      <Users size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
      <span className="min-w-0 flex-1 truncate text-left">Several at once</span>
      {choice.on && count ? (
        <span className="shrink-0 text-caption text-fg-tertiary tabular-nums">
          {count.picked} of {count.max}
        </span>
      ) : null}
      <span className="flex h-4.5 w-8 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-200 ease-out-soft group-data-checked/several:bg-accent">
        <Switch.Thumb className="size-3.5 rounded-full bg-fg-primary shadow-raised transition-[translate,background-color] duration-200 ease-out-soft data-checked:translate-x-3.5 data-checked:bg-accent-fg" />
      </span>
    </Switch.Root>
  );
}

/**
 * What the agents may do unasked, behind a button that shows the mode picked; one other than Auto
 * stands out on it, so a choice that differs from the safe default is never out of sight.
 */
export function AccessMenu({
  value,
  onPick,
  limit,
}: {
  readonly value: AccessMode;
  readonly onPick: (access: AccessMode) => void;
  /** Modes a starting model's harness can't run here: offered disabled, with its reason. */
  readonly limit?: HarnessLimit | undefined;
}) {
  const raised = value !== "auto";
  const Icon = accessIcon[value];
  const label = accessOptions.find((option) => option.value === value)?.label ?? "Auto";
  const blocked = accessOptions.some((option) => limit?.blocks.includes(option.value) === true);
  return (
    <Menu.Root>
      <Tooltip label={`Access: ${label}`}>
        <Menu.Trigger
          aria-label={`Access: ${label}`}
          className={`${chipShape} relative w-8 justify-center px-0 pointer-coarse:w-10 max-md:w-10 ${
            raised
              ? (accessChipTone[value] ??
                "bg-surface-hover text-fg-primary hover:bg-surface-active data-popup-open:bg-surface-active")
              : "text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-active data-popup-open:text-fg-primary"
          }`}
        >
          <Icon size={15} strokeWidth={1.75} />
          {value === "fullAccess" ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-attention" />
          ) : null}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className="w-44 max-w-(--available-width) origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay p-1 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0 max-md:w-52">
            <MenuRadioGroup value={value} onValueChange={(next: AccessMode) => onPick(next)}>
              {accessOptions.map((option) => {
                const OptionIcon = accessIcon[option.value];
                return (
                  <MenuRadioItem
                    key={option.value}
                    value={option.value}
                    disabled={limit?.blocks.includes(option.value) === true}
                  >
                    <OptionIcon
                      size={14}
                      strokeWidth={1.75}
                      className={`shrink-0 ${option.value === "fullAccess" ? "text-attention-text" : ""}`}
                    />
                    <span className="truncate">{option.label}</span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
            {/* The one line left: why a mode is greyed out, when one is. */}
            {blocked && limit ? (
              <p className="border-t border-line-subtle px-2 pt-1.5 pb-1 text-caption text-fg-tertiary">
                {limit.reason}
              </p>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
        className="flex h-8 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 text-meta whitespace-nowrap text-fg-tertiary"
      >
        {children}
      </Button>
    </Tooltip>
  );
}
