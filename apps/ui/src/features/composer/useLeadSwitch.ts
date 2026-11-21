import type { ModelInfo, UsageSnapshot } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { manifestsAtom } from "../../backend/atoms.ts";
import { usageAtom } from "../../backend/usage.ts";
import { useMinute } from "../../lib/useMinute.ts";
import type { ComposerTarget } from "./composerTypes.ts";
import { handoffTarget, runningLow } from "./handoff.ts";
import type { Handoff } from "./HandoffDialog.tsx";
import type { ShownModel } from "./ModelPicker.tsx";
import { effortFor, modelKey, speedFor, switchTo, type HandoffChoice, type ModelSwitch } from "./models.ts";
import { offersSpeed, type EffortChoice, type EffortPick, type SpeedChoice } from "./Pickers.tsx";

// An open thread's lead, as the box shows and switches it: the model, effort and speed it runs, which
// the user can switch mid-thread as far as its harness can, hand to another harness's model once the
// user confirms, or carry on in another harness while its own runs low.

export function useLeadSwitch({
  target,
  draftKey,
  models,
  routerOn,
  running,
}: {
  readonly target: ComposerTarget;
  readonly draftKey: string;
  readonly models: ReadonlyArray<ModelInfo>;
  /** The machine's effort router is on: a lead can be put on Auto. */
  readonly routerOn: boolean;
  readonly running: boolean;
}) {
  // An open thread's lead can take another model of its harness, or another effort or speed, when the
  // harness can switch a session. A machine too old to say (it has no manifests) offers nothing to switch.
  const thread = target.kind === "thread" ? target : undefined;
  const manifests = useAtomValue(manifestsAtom);
  const switching =
    thread?.onSwitch !== undefined && AsyncResult.isSuccess(manifests)
      ? manifests.value.find((manifest) => manifest.provider === thread.provider)?.switching
      : undefined;
  /** A pick the machine hasn't confirmed yet, which holds only while the thread still has what it was made against. */
  const [pending, setPending] = useState<{ readonly base: string; readonly choice: ModelSwitch }>();
  const base = `${draftKey}|${thread?.modelId}|${thread?.effort}|${thread?.autoEffort}|${thread?.speed}`;
  const picked = pending?.base === base ? pending.choice : undefined;
  const threadModel =
    thread === undefined
      ? undefined
      : models.find(
          (candidate) =>
            candidate.provider === thread.provider && candidate.id === (picked?.model ?? thread.modelId),
        );
  // Turning Auto on asks for no level, so the lead's own shows until the router picks one.
  const threadEffort = threadModel ? effortFor(threadModel, picked?.effort ?? thread?.effort) : undefined;
  const threadAuto = routerOn && (picked ? picked.autoEffort === true : thread?.autoEffort === true);
  const threadSpeed = threadModel ? speedFor(threadModel, picked?.speed ?? thread?.speed) : undefined;
  const switchLead = (choice: ModelSwitch) => {
    if (thread?.onSwitch === undefined) return;
    setPending({ base, choice });
    void thread.onSwitch(choice).then((done) => {
      // A refusal undoes only its own pick, not one made since.
      if (!done) setPending((current) => (current?.choice === choice ? undefined : current));
    });
  };

  // Another harness's model takes the thread over once the user confirms what goes across.
  const handoff = thread?.handoff;
  const [handingOff, setHandingOff] = useState<Handoff & { readonly choice: HandoffChoice }>();
  const askHandoff = (picked: ModelInfo) => {
    if (thread === undefined) return;
    setHandingOff({
      from: thread.provider,
      to: picked.provider,
      label: picked.label,
      choice: { provider: picked.provider, ...switchTo(picked, threadEffort, true, threadAuto, threadSpeed) },
    });
  };
  // While the lead's harness runs low, the box offers to carry on in one that isn't.
  const usage = AsyncResult.getOrElse(useAtomValue(usageAtom), (): UsageSnapshot | undefined => undefined);
  const now = useMinute();
  const low = thread && handoff ? runningLow(usage?.usage ?? [], thread.provider) : undefined;
  const lowTarget =
    thread && handoff && low
      ? handoffTarget(models, handoff.available, usage?.usage ?? [], thread.provider)
      : undefined;

  /** What the model picker shows for an open thread: the model it runs, or the name the transcript gives it. */
  const threadShown: ShownModel | undefined = thread
    ? {
        provider: thread.provider,
        label: threadModel?.label ?? thread.model,
        ...(threadModel ? { key: modelKey(threadModel) } : {}),
      }
    : undefined;

  // The lead's model, effort and speed as one chip in the box's line. It opens the harness's models,
  // with the speed and effort under them, as far as the harness can switch each mid-thread.
  const switchesModel = switching?.model === true;
  const switchesEffort = switching?.effort === true;
  const switchesSpeed = switching?.speed === true;
  const threadEffortShown: EffortPick | undefined = threadEffort
    ? threadAuto
      ? "auto"
      : threadEffort
    : undefined;
  const threadEffortChoice: EffortChoice | undefined =
    threadModel && threadEffort && switchesEffort
      ? {
          levels: threadModel.efforts,
          value: threadEffort,
          onPick: (next) => switchLead({ model: threadModel.id, effort: next, autoEffort: threadAuto }),
          ...(routerOn
            ? {
                auto: {
                  on: threadAuto,
                  onToggle: (on: boolean) =>
                    switchLead({ model: threadModel.id, effort: threadEffort, autoEffort: on }),
                },
              }
            : {}),
        }
      : undefined;
  // A speed picked keeps the lead's effort, and Auto.
  const threadSpeedChoice: SpeedChoice | undefined =
    threadModel && switchesSpeed
      ? {
          speeds: threadModel.speeds ?? [],
          value: threadSpeed ?? "standard",
          onPick: (next) => switchLead(switchTo(threadModel, threadEffort, switchesEffort, threadAuto, next)),
        }
      : undefined;
  // With a handoff the menu lists every harness: the lead's own models as far as it switches them
  // mid-thread, and every other harness's, which take the thread over once the user confirms.
  const ownModels = thread
    ? switchesModel
      ? models.filter((each) => each.provider === thread.provider)
      : threadModel
        ? [threadModel]
        : []
    : [];
  // A lead between turns can compact its conversation where its harness can when asked.
  const compacts =
    AsyncResult.isSuccess(manifests) &&
    manifests.value.find((manifest) => manifest.provider === thread?.provider)?.compact === true;
  const onCompact =
    thread?.onCompact && compacts && !running && thread.ended === undefined ? thread.onCompact : undefined;
  /** Something about the lead can be switched or set here: its chip opens a menu rather than only saying. */
  const threadPicker =
    handoff ||
    switchesModel ||
    threadEffortChoice ||
    offersSpeed(threadSpeedChoice) ||
    onCompact ||
    thread?.onLimit;
  /** The `/` list offers switching models: a new thread's, or a lead's that can switch or be handed off. */
  const offersSwitch = Boolean(
    handoff || switchesModel || threadEffortChoice || offersSpeed(threadSpeedChoice),
  );

  return {
    thread,
    manifests,
    switching,
    threadModel,
    threadEffort,
    threadAuto,
    threadSpeed,
    switchLead,
    handoff,
    handingOff,
    setHandingOff,
    askHandoff,
    now,
    low,
    lowTarget,
    threadShown,
    switchesModel,
    switchesEffort,
    threadEffortShown,
    threadEffortChoice,
    threadSpeedChoice,
    ownModels,
    onCompact,
    threadPicker,
    offersSwitch,
  };
}

export type LeadSwitch = ReturnType<typeof useLeadSwitch>;
