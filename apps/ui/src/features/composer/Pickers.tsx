import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { AccessMode, HarnessLimit, ReasoningEffort } from "@cerium/protocol";
import {
  Ellipsis,
  Eye,
  FilePen,
  Route,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  MenuCheckboxItem,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { accessOptions, effortHint, effortLabel, MAX_AGENTS } from "./models.ts";

// The message box's own controls beside the model menu (ModelPicker.tsx): the effort row inside that
// menu, and the menu of what's seldom changed (access, several models at once).

/** A control in the box's rows, without its colours: a pill, the box itself being one. */
const chipShape =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta whitespace-nowrap transition-colors select-none";

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

/** The effort row's labels, short enough for Auto and six levels to sit side by side. */
const segmentLabel: Record<ReasoningEffort | "auto", string> = {
  auto: "Auto",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

/** One pick of how hard a model thinks: a level it offers, or Auto for the effort router to pick. */
export type EffortPick = ReasoningEffort | "auto";

/** What the model menu offers for the picked model's effort. */
export interface EffortChoice {
  /** The levels on offer, weakest first. */
  readonly levels: ReadonlyArray<ReasoningEffort>;
  readonly value: EffortPick;
  /** The effort router is on, so Auto leads the levels. */
  readonly auto: boolean;
  readonly onPick: (effort: EffortPick) => void;
}

/** Every pick the row offers, in order: Auto first when the router is on. */
export const effortSteps = (choice: EffortChoice): ReadonlyArray<EffortPick> =>
  choice.auto ? ["auto", ...choice.levels] : choice.levels;

/** Whether there's anything to pick: one level and no router leaves nothing. */
export const offersChoice = (choice: EffortChoice | undefined): choice is EffortChoice =>
  choice !== undefined && effortSteps(choice).length > 1;

/**
 * The model menu's foot: how hard the picked model thinks, one segment per level and Auto first, so
 * the model and its effort are one decision in one menu.
 */
export function EffortRow({ choice, model }: { readonly choice: EffortChoice; readonly model: string }) {
  return (
    <div className="shrink-0 border-t border-line-subtle px-2.5 pt-2 pb-2.5">
      <div className="flex items-baseline justify-between gap-3 px-0.5 pb-1.5 text-caption">
        <span className="truncate text-fg-tertiary">Effort for {model}</span>
        <span className="shrink-0 text-fg-secondary">{effortHint[choice.value]}</span>
      </div>
      <ToggleGroup
        value={[choice.value]}
        onValueChange={(value) => {
          const next = value[0] as EffortPick | undefined;
          if (next !== undefined) choice.onPick(next);
        }}
        aria-label={`Effort for ${model}`}
        className="flex gap-0.5 rounded-[9px] bg-surface-sunken p-0.5"
      >
        {effortSteps(choice).map((step) => (
          <Toggle
            key={step}
            value={step}
            aria-label={chipEffortLabel[step]}
            // The menu's search keeps focus, so typing and the arrow keys carry on after a click.
            onMouseDown={(event) => event.preventDefault()}
            className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-[7px] text-meta whitespace-nowrap text-fg-tertiary transition-colors select-none hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-focus-ring data-pressed:bg-surface-overlay data-pressed:font-medium data-pressed:text-fg-primary data-pressed:shadow-[0_0_0_1px_var(--line-strong)] max-md:h-9"
          >
            {step === "auto" ? <Route size={11} strokeWidth={2} /> : null}
            {segmentLabel[step]}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * What's seldom changed, behind one button: what the agents may do unasked, and starting several
 * models at once. Access other than Auto shows as the button's icon, so a choice that differs from
 * the safe default is never out of sight.
 */
export function MoreMenu({
  access,
  several,
}: {
  readonly access?: {
    readonly value: AccessMode;
    readonly onPick: (access: AccessMode) => void;
    /** Modes a starting model's harness can't run here: offered disabled, with its reason. */
    readonly limit?: HarnessLimit | undefined;
  };
  readonly several?: { readonly on: boolean; readonly onChange: (on: boolean) => void };
}) {
  if (access === undefined && several === undefined) return null;
  const shown = access !== undefined && access.value !== "auto" ? access.value : undefined;
  const Icon = shown ? accessIcon[shown] : Ellipsis;
  const label = shown ? accessOptions.find((option) => option.value === shown)?.label : undefined;
  return (
    <Menu.Root>
      <Tooltip label={label ? `Access: ${label}` : access ? "Access, several at once" : "Several at once"}>
        <Menu.Trigger
          aria-label={label ? `Access: ${label}` : "More options"}
          className={`${chipShape} relative w-8 justify-center px-0 ${
            shown
              ? (accessChipTone[shown] ??
                "bg-surface-hover text-fg-primary hover:bg-surface-active data-popup-open:bg-surface-active")
              : "text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-active data-popup-open:text-fg-primary"
          }`}
        >
          <Icon size={shown ? 15 : 16} strokeWidth={1.75} />
          {shown === "fullAccess" ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-attention" />
          ) : null}
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className="w-[25rem] max-w-(--available-width) origin-(--transform-origin) rounded-xl border border-line-subtle bg-surface-overlay p-1 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            {access ? (
              <Menu.Group>
                <MenuGroupLabel>What agents may do without asking</MenuGroupLabel>
                <MenuRadioGroup
                  value={access.value}
                  onValueChange={(value: AccessMode) => access.onPick(value)}
                >
                  {accessOptions.map((option) => {
                    const blocked = access.limit?.blocks.includes(option.value) === true;
                    const OptionIcon = accessIcon[option.value];
                    return (
                      <MenuRadioItem key={option.value} value={option.value} disabled={blocked}>
                        <OptionIcon
                          size={14}
                          strokeWidth={1.75}
                          className={`mt-0.5 shrink-0 self-start ${option.value === "fullAccess" ? "text-attention" : ""}`}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span>{option.label}</span>
                          <span className="text-caption text-fg-tertiary">
                            {blocked ? access.limit?.reason : option.description}
                          </span>
                        </span>
                      </MenuRadioItem>
                    );
                  })}
                </MenuRadioGroup>
              </Menu.Group>
            ) : null}
            {access && several ? <MenuSeparator /> : null}
            {several ? (
              <MenuCheckboxItem checked={several.on} onCheckedChange={several.onChange} closeOnClick>
                <Users size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 self-start" />
                <span className="flex min-w-0 flex-col">
                  <span>Several at once</span>
                  <span className="text-caption text-fg-tertiary">
                    A thread each, for up to {MAX_AGENTS} models
                  </span>
                </span>
              </MenuCheckboxItem>
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
