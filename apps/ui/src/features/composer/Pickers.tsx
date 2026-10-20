import { Button } from "@base-ui/react/button";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";
import { Eye, FilePen, Gauge, ShieldCheck, ShieldOff, ShieldQuestion, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
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

/** Picks among the efforts the model, or the models, offer. */
export function EffortPicker({
  efforts,
  value,
  onPick,
}: {
  readonly efforts: ReadonlyArray<ReasoningEffort>;
  readonly value: ReasoningEffort;
  readonly onPick: (effort: ReasoningEffort) => void;
}) {
  return (
    <SelectRoot
      value={value}
      onValueChange={(effort: ReasoningEffort | null) => {
        if (effort !== null) onPick(effort);
      }}
    >
      <SelectTrigger label="Reasoning effort">
        <Gauge size={13} strokeWidth={1.75} />
        {effortLabel[value]}
      </SelectTrigger>
      <SelectPopup>
        {efforts.map((level) => (
          <SelectItem key={level} value={level}>
            {effortLabel[level]}
          </SelectItem>
        ))}
      </SelectPopup>
    </SelectRoot>
  );
}

/** What agents may do without asking; fixed once the thread starts. */
export function AccessPicker({
  value,
  onPick,
}: {
  readonly value: AccessMode;
  readonly onPick: (access: AccessMode) => void;
}) {
  const Icon = accessIcon[value];
  return (
    <SelectRoot
      value={value}
      onValueChange={(access: AccessMode | null) => {
        if (access !== null) onPick(access);
      }}
    >
      <SelectTrigger label="Access">
        <Icon size={13} strokeWidth={1.75} />
        {accessOptions.find((option) => option.value === value)?.label}
      </SelectTrigger>
      <SelectPopup>
        {accessOptions.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            icon={accessIcon[option.value]}
            description={option.description}
          >
            {option.label}
          </SelectItem>
        ))}
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
