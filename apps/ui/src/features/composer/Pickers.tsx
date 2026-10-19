import { Button } from "@base-ui/react/button";
import type { AccessMode, ModelInfo, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { Eye, FilePen, Gauge, ShieldCheck, ShieldOff, ShieldQuestion, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import {
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
} from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { providerName } from "../threads/model.ts";
import { accessOptions, effortLabel, modelKey } from "./models.ts";

// The pickers in the message box's toolbar. A new thread picks all of them; an open thread's lead
// can pick its model and effort again, within its harness, when the harness allows it.

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

/** What the model picker's trigger shows: the model in use, which the list may not offer any more. */
export interface ShownModel {
  readonly provider: ProviderId;
  readonly label: string;
  /** Its `modelKey`; absent when the list doesn't hold it. */
  readonly key?: string;
}

/**
 * Picks a model from the harnesses' own lists. A harness that can't run (not installed, or signed
 * out) is named without its models, which would only be greyed out.
 */
export function ModelPicker({
  models,
  shown,
  providers,
  available,
  onPick,
  note,
}: {
  readonly models: ReadonlyArray<ModelInfo>;
  /** Undefined while no harness has listed a model yet. */
  readonly shown: ShownModel | undefined;
  /** The harnesses to list, in order. One needs no heading. */
  readonly providers: ReadonlyArray<ProviderId>;
  readonly available: ReadonlySet<ProviderId>;
  readonly onPick: (model: ModelInfo) => void;
  /** Said at the foot of the list. */
  readonly note?: string;
}) {
  return (
    <SelectRoot
      value={shown?.key ?? null}
      onValueChange={(key) => {
        const picked = models.find((model) => modelKey(model) === key);
        if (picked !== undefined) onPick(picked);
      }}
    >
      <SelectTrigger label="Model">
        {shown ? (
          <>
            <ProviderLogo provider={shown.provider} size={13} />
            <span className="font-medium text-fg-primary">{shown.label}</span>
          </>
        ) : (
          <span className="text-fg-tertiary">Finding models…</span>
        )}
      </SelectTrigger>
      <SelectPopup>
        {providers.map((provider, index) => {
          const usable = available.has(provider);
          // Harnesses that can't run follow each other as plain rows, with no rule between them.
          const previous = providers[index - 1];
          return (
            <SelectGroup key={provider}>
              {previous !== undefined && (usable || available.has(previous)) ? <SelectSeparator /> : null}
              {providers.length > 1 || !usable ? (
                <SelectGroupLabel>
                  <ProviderLogo
                    provider={provider}
                    size={11}
                    {...(usable ? {} : { className: "opacity-35 grayscale" })}
                  />
                  {providerName[provider]}
                  {usable ? null : <span className="ml-auto font-normal text-fg-disabled">Unavailable</span>}
                </SelectGroupLabel>
              ) : null}
              {usable
                ? models
                    .filter((model) => model.provider === provider)
                    .map((model) => (
                      <SelectItem key={model.id} value={modelKey(model)}>
                        {model.label}
                      </SelectItem>
                    ))
                : null}
            </SelectGroup>
          );
        })}
        {note ? <p className="px-2 pt-1.5 pb-1 text-2xs text-fg-tertiary">{note}</p> : null}
      </SelectPopup>
    </SelectRoot>
  );
}

/** Picks among the efforts the model offers. */
export function EffortPicker({
  model,
  value,
  onPick,
}: {
  readonly model: ModelInfo;
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
        {model.efforts.map((level) => (
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
