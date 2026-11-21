import { OFFERED_PROVIDERS, type ModelInfo } from "@cerium/protocol";
import { AsyncResult } from "effect/reactivity";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { providerName } from "../threads/model.ts";
import { contextLabel, ContextRing } from "../agents/ContextMeter.tsx";
import { MAX_AGENTS, modelKey, switchTo } from "./models.ts";
import { ModelPicker, ModelsPicker } from "./ModelPicker.tsx";
import {
  chipEffortLabel,
  FixedChip,
  SpeedMark,
  type EffortChoice,
  type EffortPick,
  type SpeedChoice,
} from "./Pickers.tsx";

import type { ComposerTarget } from "./composerTypes.ts";
import type { LeadSwitch } from "./useLeadSwitch.ts";
import type { StartChoices } from "./useStartChoices.ts";

const providers = OFFERED_PROVIDERS;

// Both paths render into the same slot, so a draft becoming a thread can keep its ModelPicker.

export function leadModelChip({
  lead,
  models,
  open: modelsOpen,
  onOpenChange: setModelsOpen,
  running,
}: {
  readonly lead: LeadSwitch;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly running: boolean;
}) {
  const {
    thread,
    threadShown,
    threadPicker,
    handoff,
    ownModels,
    threadEffortChoice,
    threadEffortShown,
    threadSpeedChoice,
    threadSpeed,
    switchLead,
    threadEffort,
    switchesEffort,
    threadAuto,
    askHandoff,
    onCompact,
    switchesModel,
    manifests,
    switching,
  } = lead;
  return thread && threadShown ? (
    threadPicker ? (
      <ModelPicker
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        models={
          handoff ? [...ownModels, ...models.filter((each) => each.provider !== thread.provider)] : ownModels
        }
        shown={threadShown}
        providers={handoff ? providers : [thread.provider]}
        available={new Set([thread.provider, ...(handoff?.available ?? [])])}
        effort={threadEffortChoice}
        effortShown={threadEffortShown}
        speed={threadSpeedChoice}
        speedShown={threadSpeed}
        limit={thread.onLimit}
        leaves={(picked) => picked.provider !== thread.provider}
        onPick={(picked) =>
          picked.provider === thread.provider
            ? switchLead(switchTo(picked, threadEffort, switchesEffort, threadAuto, threadSpeed))
            : askHandoff(picked)
        }
        context={thread.context}
        onCompact={onCompact}
        {...(running
          ? { note: "Applies from the next turn" }
          : switchesModel || handoff
            ? {}
            : { note: `${providerName[thread.provider]} can't switch models mid-thread` })}
      />
    ) : (
      <FixedChip
        tip={[
          ...(thread.context ? [contextLabel(thread.context)] : []),
          AsyncResult.isFailure(manifests)
            ? "Update Cerium on that computer to switch models"
            : switching
              ? `${providerName[thread.provider]} can't switch models mid-thread`
              : "The model this thread started with",
        ].join(" · ")}
      >
        <ProviderLogo provider={thread.provider} size={13} />
        <span className="max-w-40 truncate font-medium text-fg-primary">{threadShown.label}</span>
        {threadEffortShown ? <span>{chipEffortLabel[threadEffortShown]}</span> : null}
        <SpeedMark speed={threadSpeed} />
        <ContextRing context={thread.context} />
      </FixedChip>
    )
  ) : null;
}

export function startModelChip({
  target,
  start,
  open: modelsOpen,
  onOpenChange: setModelsOpen,
}: {
  readonly target: Extract<ComposerTarget, { kind: "new" }>;
  readonly start: StartChoices;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const {
    activeEffort,
    autoEffort,
    efforts,
    setEffort,
    routerOn,
    pickForDraft,
    speeds,
    activeSpeed,
    setSpeed,
    models,
    multi,
    setMulti,
    starting,
    worktree,
    access,
    gitFolder,
    branch,
    setWorkplace,
    model,
    setModelId,
  } = start;
  // A new thread's model and effort, the same chip; on Auto, the level picked is its fallback.
  const newEffortShown: EffortPick | undefined = activeEffort
    ? autoEffort
      ? "auto"
      : activeEffort
    : undefined;
  const newEffortChoice: EffortChoice | undefined = activeEffort
    ? {
        levels: efforts,
        value: activeEffort,
        onPick: setEffort,
        ...(routerOn
          ? { auto: { on: autoEffort, onToggle: (on: boolean) => pickForDraft({ autoEffort: on }) } }
          : {}),
      }
    : undefined;
  const newSpeedChoice: SpeedChoice = { speeds, value: activeSpeed ?? "standard", onPick: setSpeed };
  // Several models at once, switched on in the model menu's foot, once there are several to pick.
  const several =
    models.filter((each) => target.available.has(each.provider)).length > 1
      ? { on: multi, onChange: setMulti }
      : undefined;
  return multi ? (
    <ModelsPicker
      models={models}
      chosen={starting}
      providers={providers}
      available={target.available}
      max={MAX_AGENTS}
      open={modelsOpen}
      onOpenChange={setModelsOpen}
      effort={newEffortChoice}
      effortShown={newEffortShown}
      speed={newSpeedChoice}
      speedShown={activeSpeed}
      several={several}
      onPick={(keys) => pickForDraft({ models: keys })}
      // Agents that may edit share the one folder, where they can undo each other's work.
      {...(target.mode === "work" && !worktree && access !== "readOnly" && starting.length > 1
        ? {
            note: "They share the folder, so their edits can collide",
            ...(gitFolder !== undefined && branch !== undefined
              ? {
                  onUseWorktrees: () => {
                    setWorkplace("worktree");
                    pickForDraft({ worktree: true, workspace: undefined });
                  },
                }
              : {}),
          }
        : {})}
    />
  ) : (
    <ModelPicker
      models={models}
      shown={model ? { provider: model.provider, label: model.label, key: modelKey(model) } : undefined}
      providers={providers}
      available={target.available}
      // Shared with multi agent's menu, so switching between them keeps the menu open.
      open={modelsOpen}
      onOpenChange={setModelsOpen}
      effort={newEffortChoice}
      effortShown={newEffortShown}
      speed={newSpeedChoice}
      speedShown={activeSpeed}
      several={several}
      onPick={(picked) => setModelId(modelKey(picked))}
    />
  );
}
