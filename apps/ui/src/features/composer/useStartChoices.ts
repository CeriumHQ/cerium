import {
  OFFERED_PROVIDERS,
  type AccessMode,
  type ModelSpeed,
  type ProviderId,
  type ReasoningEffort,
} from "@cerium/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { harnessesAtom, settingsAtom } from "../../backend/atoms.ts";
import { gitBranchAtom } from "../../backend/projects.ts";
import {
  accessAtom,
  chatEffortAtom,
  chatModelAtom,
  chatSpeedAtom,
  effortAtom,
  modelAtom,
  speedAtom,
  workplaceAtom,
} from "../settings/preferences.ts";
import type { ComposerTarget } from "./composerTypes.ts";
import type { Draft, DraftStart } from "./draft.ts";
import {
  accessLimit,
  allowedAccess,
  effortFor,
  effortsOf,
  modelKey,
  pickModel,
  pickModels,
  speedFor,
  speedsOf,
  useModels,
} from "./models.ts";

// What a message starts or goes to, as the box picks it: the model (or several), effort, speed and
// access a new thread starts with, and the folder, checkout and branch either kind of thread works in.
// A pick made in a new thread's box stays with its draft; nothing else changes it.

const allProviders: ReadonlySet<ProviderId> = new Set(OFFERED_PROVIDERS);

/** The picks a new thread's draft remembers. */
export type DraftPick = Partial<
  Pick<
    DraftStart,
    "folder" | "model" | "models" | "effort" | "autoEffort" | "speed" | "access" | "worktree" | "workspace"
  >
>;

export function useStartChoices({
  target,
  draft,
  draftKey,
  connecting,
  updateDraft,
  startOf,
  onOpenModels,
}: {
  readonly target: ComposerTarget;
  readonly draft: Draft;
  readonly draftKey: string;
  readonly connecting: boolean;
  readonly updateDraft: (key: string, update: (current: Draft) => Draft) => void;
  /** How the open thread not started yet starts, the first time the user writes or picks anything in it. */
  readonly startOf: (current: Draft) => DraftStart | undefined;
  /** Opens the model menu, which multi agent opens on to add more models. */
  readonly onOpenModels: () => void;
}) {
  // Work and chat each remember their own model, effort and speed defaults, so changing one in a
  // chat composer never overwrites the coding default (and vice versa). Until a chat model is picked,
  // chat falls back to the work model while keeping its own lighter effort default.
  const isChat = target.kind === "new" && target.mode === "chat";
  const [workModel, setWorkModel] = useAtom(modelAtom);
  const [chatModel, setChatModel] = useAtom(chatModelAtom);
  const [workEffort, setWorkEffort] = useAtom(effortAtom);
  const [chatEffort, setChatEffort] = useAtom(chatEffortAtom);
  const [workSpeed, setWorkSpeed] = useAtom(speedAtom);
  const [chatSpeed, setChatSpeed] = useAtom(chatSpeedAtom);
  const defaultModel = isChat ? chatModel || workModel : workModel;
  const setDefaultModel = isChat ? setChatModel : setWorkModel;
  const defaultEffort = isChat ? chatEffort : workEffort;
  const setDefaultEffort = isChat ? setChatEffort : setWorkEffort;
  const defaultSpeed = isChat ? chatSpeed : workSpeed;
  const setDefaultSpeed = isChat ? setChatSpeed : setWorkSpeed;
  const defaultAccess = useAtomValue(accessAtom);
  const modelId = draft.start?.model ?? defaultModel;
  const effort = draft.start?.effort ?? defaultEffort;
  const speed = draft.start?.speed ?? defaultSpeed;
  const pickedAccess = draft.start?.access ?? defaultAccess;
  // While the machine's effort router is on, a new thread starts on Auto unless taken off it.
  const settings = useAtomValue(settingsAtom);
  const routerOn = AsyncResult.isSuccess(settings) && settings.value.effortRouter.enabled;
  const autoEffort = routerOn && (draft.start?.autoEffort ?? true);
  const [workplace, setWorkplace] = useAtom(workplaceAtom);
  /** A worktree is offered for a work thread in a folder git keeps, on a machine that makes them. */
  const gitFolder =
    target.kind === "new" && target.mode === "work" && target.worktrees === true ? target.folder : undefined;
  const workFolder =
    target.kind === "thread" ? target.folder : target.mode === "work" ? target.folder : undefined;
  const checkout =
    target.kind === "thread"
      ? (target.worktree?.root ?? workFolder)
      : (draft.start?.workspace?.path ?? workFolder);
  const branchFolder = gitFolder ?? checkout;
  const branch = AsyncResult.getOrElse(
    useAtomValue(gitBranchAtom(connecting ? "" : (branchFolder ?? ""))),
    () => undefined,
  );
  const checkoutBranch = AsyncResult.getOrElse(
    useAtomValue(gitBranchAtom(connecting || checkout === branchFolder ? "" : (checkout ?? ""))),
    () => undefined,
  );
  const worktree =
    gitFolder !== undefined && branch !== undefined && (draft.start?.worktree ?? workplace === "worktree");

  const models = useModels();
  const usable = target.kind === "new" ? target.available : allProviders;
  const model = pickModel(models, modelId, usable);
  const isNew = target.kind === "new";
  /** Multi agent: the models the first message starts a thread each with, side by side. */
  const multi = isNew && draft.start?.models !== undefined;
  const chosen = multi ? pickModels(models, draft.start?.models ?? [], usable) : [];
  /** What the message starts: a thread with each chosen model, else one with the model. */
  const starting = multi && chosen.length > 0 ? chosen : model ? [model] : [];
  // A mode a starting model's harness can't run here is offered disabled; the pick stays with the
  // draft, for when that model is swapped out.
  const limit = accessLimit(
    AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []),
    starting,
  );
  const access = isNew && target.mode === "chat" ? "readOnly" : allowedAccess(pickedAccess, limit);
  const blockedAccess = isNew && limit?.blocks.includes(access) ? limit.reason : undefined;
  /** One effort for every model starting; each model that lacks it runs at its own default. */
  const efforts = effortsOf(starting);
  // Keep the effort valid when switching to a model with fewer levels.
  const activeEffort =
    multi && effort !== undefined && efforts.includes(effort)
      ? effort
      : starting.map((each) => effortFor(each, effort)).find((each) => each !== undefined);
  /** One speed for every model starting, the same way; each model that lacks it runs at its default. */
  const speeds = speedsOf(starting);
  const activeSpeed =
    multi && speed !== undefined && speeds.includes(speed)
      ? speed
      : starting.map((each) => speedFor(each, speed)).find((each) => each !== undefined);

  /** Remembers a pick in the open new thread's draft; nothing else changes it. */
  const pickForDraft = (pick: DraftPick) =>
    updateDraft(draftKey, (current) => {
      const start = startOf(current);
      return start ? { ...current, start: { ...start, ...pick } } : current;
    });
  /** Multi agent on, starting from the model picked so far with its list open to add more, or off, back to the first one picked. */
  const setMulti = (on: boolean) => {
    if (on) {
      pickForDraft({ models: model ? [modelKey(model)] : [] });
      onOpenModels();
      return;
    }
    const first = chosen[0];
    if (first) setDefaultModel(modelKey(first));
    updateDraft(draftKey, (current) => {
      if (current.start === undefined) return current;
      const { models: _, ...start } = current.start;
      return { ...current, start: first ? { ...start, model: modelKey(first) } : start };
    });
  };
  const setModelId = (value: string) => {
    setDefaultModel(value);
    pickForDraft({ model: value });
  };
  /** A level picked by hand: on Auto, the one the thread falls back to. */
  const setEffort = (value: ReasoningEffort) => {
    setDefaultEffort(value);
    pickForDraft({ effort: value });
  };
  const setSpeed = (value: ModelSpeed) => {
    setDefaultSpeed(value);
    pickForDraft({ speed: value });
  };
  const setAccess = (value: AccessMode) => pickForDraft({ access: value });

  return {
    settings,
    routerOn,
    models,
    model,
    isNew,
    multi,
    starting,
    limit,
    access,
    blockedAccess,
    efforts,
    activeEffort,
    autoEffort,
    speeds,
    activeSpeed,
    gitFolder,
    workFolder,
    branch,
    checkoutBranch,
    worktree,
    setWorkplace,
    pickForDraft,
    setMulti,
    setModelId,
    setEffort,
    setSpeed,
    setAccess,
  };
}

export type StartChoices = ReturnType<typeof useStartChoices>;
