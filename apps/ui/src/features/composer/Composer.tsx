import { Button } from "@base-ui/react/button";
import {
  OFFERED_PROVIDERS,
  matchPrompts,
  visiblePrompts,
  type AccessMode,
  type Attachment,
  type Mention,
  type ModelInfo,
  type ModelSpeed,
  type ProviderId,
  type ReasoningEffort,
  type UsageSnapshot,
} from "@cerium/protocol";
import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowRightLeft, ArrowUp, Paperclip, Square } from "lucide-react";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { harnessesAtom, manifestsAtom, settingsAtom } from "../../backend/atoms.ts";
import { saveAttachment } from "../../backend/files.ts";
import { machineAtom } from "../../backend/machine.ts";
import { usageAtom } from "../../backend/usage.ts";
import { useMinute } from "../../lib/useMinute.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Reveal } from "../../components/Reveal.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useChanged, useMorph } from "../../lib/motion.ts";
import { launch } from "./flight.ts";
import { useKeyboardOpen } from "../../web/viewport.ts";
import { usesCommandKey } from "../../lib/keys.ts";
import { bindingFor, isCapturingBinding, matchesBinding, shortcutBindingsAtom } from "../../lib/shortcuts.ts";
import { matchCommands, type PaletteCommand } from "../palette/palette.ts";
import { queryWords } from "../threads/threadSearch.ts";
import { gitBranchAtom } from "../../backend/projects.ts";
import { WEB } from "../../backend/target.ts";
import { DictationControl, DictationNotice } from "../dictation/DictationControl.tsx";
import { useDictation } from "../dictation/useDictation.ts";
import {
  accessAtom,
  effortAtom,
  isSendKey,
  modelAtom,
  sendKeyAtom,
  speedAtom,
  workplaceAtom,
} from "../settings/preferences.ts";
import { providerName } from "../threads/model.ts";
import { contextLabel, ContextRing } from "../agents/ContextMeter.tsx";
import type { AgentContext } from "../agents/model.ts";
import { AttachmentTray } from "./AttachmentTray.tsx";
import { CommentTray } from "./CommentTray.tsx";
import { isPreviewable, mediaTypeOf, prepareAttachment } from "./attachments.ts";
import {
  draftMentions,
  segmentsOf,
  draftText,
  emptyDraft,
  hasContent,
  withComments,
  type Draft,
  type DraftAttachment,
  type DraftStart,
  type Trigger,
} from "./draft.ts";
import { draftAtom, draftsAtom, isNewDraftKey, startedNow, withDraft, withoutDraft } from "./drafts.ts";
import { MentionMenu, useMentionOptions } from "./MentionMenu.tsx";
import type { MessageBox } from "./messageBox.ts";
import {
  accessLimit,
  allowedAccess,
  effortFor,
  effortsOf,
  MAX_AGENTS,
  modelKey,
  pickModel,
  pickModels,
  speedFor,
  speedsOf,
  switchTo,
  useModels,
  type HandoffChoice,
  type ModelSwitch,
} from "./models.ts";
import { handoffTarget, runningLow } from "./handoff.ts";
import { HandoffDialog, LowLimitNotice, type Handoff } from "./HandoffDialog.tsx";
import { ModelPicker, ModelsPicker, type ShownModel } from "./ModelPicker.tsx";
import {
  chipEffortLabel,
  FixedChip,
  MoreMenu,
  offersSpeed,
  SpeedMark,
  type EffortChoice,
  type EffortPick,
  type SpeedChoice,
} from "./Pickers.tsx";
import { useCoarsePointer } from "./pointer.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor.tsx";
import { SlashMenu, slashGroups, type SlashEntry } from "./SlashMenu.tsx";
import { WorktreePicker } from "./WorktreePicker.tsx";
import { QueueTray, type Queue } from "./QueueTray.tsx";

/**
 * The dictate binding starts and stops dictation, which no browser or Windows key takes in a text
 * box. Control stays the Control key itself, even on a Mac where ⌘M minimizes (lib/shortcuts.ts).
 */
const isDictationKey = (event: KeyboardEvent<HTMLDivElement>, binding: string, mac: boolean) =>
  matchesBinding(event, binding, mac);

const providers = OFFERED_PROVIDERS;
const allProviders: ReadonlySet<ProviderId> = new Set(providers);

/**
 * Whether two mention triggers are one: the same character at the same place, with the same query.
 * Out here because the React Compiler skips a component whose condition chains optional comparisons.
 */
const sameTrigger = (a: Trigger | undefined, b: Trigger | undefined) =>
  a?.char === b?.char && a?.start === b?.start && a?.query === b?.query;

/** A message as the box sends it: its text, which names each mention by its token. */
export interface OutgoingMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly mentions: ReadonlyArray<Mention>;
}

/** What a new thread starts with. */
export interface ThreadSetup {
  readonly provider: ProviderId;
  readonly model: string;
  /** Absent for models the harness offers no effort setting for. */
  readonly effort?: ReasoningEffort;
  /** The effort router picks the lead's effort each turn, starting from `effort`. */
  readonly autoEffort?: boolean;
  /** Absent for models served at one speed. */
  readonly speed?: ModelSpeed;
  readonly access: AccessMode;
  /** A work thread runs in a git worktree of its own. */
  readonly worktree?: boolean;
}

export type ComposerTarget =
  /** Messages go to an existing thread's lead. */
  | {
      readonly kind: "thread";
      readonly provider: ProviderId;
      /** The model as the transcript names it, for when the harness no longer lists it. */
      readonly model: string;
      /** The model as the harness lists it, which the picker matches. */
      readonly modelId: string;
      /** Absent for models the harness offers no effort setting for. */
      readonly effort?: ReasoningEffort | undefined;
      /** The effort router picks the lead's effort each turn. */
      readonly autoEffort?: boolean | undefined;
      /** Absent for a lead at its harness's default speed. */
      readonly speed?: ModelSpeed | undefined;
      /** The thread's folder, which `@` tags files from; absent for chats. */
      readonly folder?: string | undefined;
      /** The thread's own worktree's branch, and the branch it was made from. */
      readonly worktree?: { readonly branch: string; readonly base: string } | undefined;
      /** The lead stopped or failed; the next message picks the thread back up. */
      readonly ended?: "stopped" | "failed";
      /**
       * Switches the lead to another model of its harness, or another effort or speed, from its next turn.
       * Resolves false when it didn't go through. Absent where the box can't ask for that.
       */
      readonly onSwitch?: (choice: ModelSwitch) => Promise<boolean>;
      /** The lead's context as its harness last measured it; absent where it reports none. */
      readonly context?: AgentContext | undefined;
      /** Asks the lead's harness to compact its conversation, offered where the harness can. */
      readonly onCompact?: () => void;
      /**
       * Hands the lead to a model of another harness, which the user confirms first; its model menu
       * then lists every harness. Absent where the machine can't.
       */
      readonly handoff?: {
        /** Harnesses installed and signed in. */
        readonly available: ReadonlySet<ProviderId>;
        /** How many of the agents the lead spawned still run. */
        readonly agents: number;
        /** Resolves false when it didn't go through. */
        readonly onHandOff: (choice: HandoffChoice) => Promise<boolean>;
      };
    }
  /** The first message starts a thread with the chosen setup. */
  | {
      readonly kind: "new";
      readonly mode: "work" | "chat";
      /** Work threads need a folder before they can start. */
      readonly folder: string | undefined;
      readonly onChooseFolder: (folder: string) => void;
      /** Providers whose harness is installed and logged in. */
      readonly available: ReadonlySet<ProviderId>;
      /** The machine can give a thread a worktree of its own. */
      readonly worktrees?: boolean;
    };

interface ComposerProps {
  readonly target: ComposerTarget;
  /** Which draft the box shows: each thread, and each thread not started yet, keeps its own. */
  readonly draftKey: string;
  /** The thread's machine hasn't answered yet: the box takes writing, and sending waits for it. */
  readonly connecting?: boolean;
  /** The message box, for callers that move focus to it. */
  readonly inputRef?: RefObject<HTMLDivElement | null>;
  /** Filled with what others can put into the box; null while it takes no messages. */
  readonly messageBox?: Ref<MessageBox | null>;
  /** A turn is in progress: the send button becomes stop. */
  readonly running: boolean;
  /**
   * Resolves false when the message didn't go through, so the box can give the draft back. A new
   * thread starts with the first setup; multi agent starts one more thread with each of the rest.
   */
  readonly onSend: (
    message: OutgoingMessage,
    setups: readonly [ThreadSetup, ...Array<ThreadSetup>],
  ) => Promise<boolean>;
  readonly onStop: () => void;
  /** Shown just above the box, such as requests waiting on the user. */
  readonly above?: ReactNode;
  /** Reports how tall the box stands over the transcript, with what sits above it, so the transcript's end stays in view. */
  readonly onHeight?: (height: number) => void;
  /** Opening a thread puts the cursor in the box; not in a pane beside the focused one. */
  readonly takesFocus?: boolean;
  /** The step the lead's running turn is on, written in the empty box's line while it runs. */
  readonly activity?: ReactNode;
  /** The user's messages waiting for the lead, listed at the top of the box. */
  readonly queue?: Queue | undefined;
  /**
   * The command palette's actions the `/` list offers: new thread, find in thread, and so on. The
   * box adds switching models and stopping its turn beside them.
   */
  readonly slashCommands?: ReadonlyArray<PaletteCommand> | undefined;
  /**
   * Where a new thread's box sits in the window, under the question (app/EmptyThread.tsx). Without
   * one, or where the box wouldn't fit there, it floats at the pane's foot, and drops there from its seat.
   */
  readonly seat?: number | undefined;
}

/** The message box, floating over the bottom of the transcript. */
export function Composer({
  target,
  draftKey,
  connecting = false,
  inputRef,
  messageBox,
  running,
  onSend,
  onStop,
  above,
  onHeight,
  takesFocus = true,
  activity,
  queue,
  slashCommands = [],
  seat,
}: ComposerProps) {
  const setDrafts = useAtomSet(draftsAtom);
  const machine = useAtomValue(machineAtom);
  /** Bumped when the box itself replaces a draft (sent, or given back), so the editor shows it. */
  const [epoch, setEpoch] = useState(0);
  const ownRef = useRef<HTMLDivElement>(null);
  const input = inputRef ?? ownRef;
  const editor = useRef<PromptEditorHandle>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  /** The `@` or `$` tag being typed. */
  const [trigger, setTrigger] = useState<Trigger>();
  /** A tag whose list Esc closed; it stays closed until another tag starts. */
  const [dismissed, setDismissed] = useState<Trigger>();
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  /**
   * Writing in the box, or using what it opened, which unfolds a new thread's setup row. Focus that
   * moves among the box's controls and their menus (portalled, but still under the box in React's
   * tree) keeps it; focus that leaves for good folds it, a frame later.
   */
  const [focused, setFocused] = useState(takesFocus);
  const focusMoves = useRef(0);
  const registry = useContext(RegistryContext);
  const draft = useAtomValue(draftAtom(draftKey)) ?? emptyDraft;
  // New threads start with the model, effort and speed the last one was given, which are also the
  // defaults in settings. Access always starts from the settings default. A pick here stays with the draft.
  const [defaultModel, setDefaultModel] = useAtom(modelAtom);
  const [defaultEffort, setDefaultEffort] = useAtom(effortAtom);
  const [defaultSpeed, setDefaultSpeed] = useAtom(speedAtom);
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
  const branch = AsyncResult.getOrElse(useAtomValue(gitBranchAtom(gitFolder ?? "")), () => undefined);
  const worktree =
    gitFolder !== undefined && branch !== undefined && (draft.start?.worktree ?? workplace === "worktree");
  const sendKey = useAtomValue(sendKeyAtom);
  const bindings = useAtomValue(shortcutBindingsAtom);
  const touch = useCoarsePointer();

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
  const access = allowedAccess(pickedAccess, limit);
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
  const [modelsOpen, setModelsOpen] = useState(false);
  const needsFolder = isNew && target.mode === "work" && target.folder === undefined;
  const text = draftText(draft.segments);
  const preparing = draft.attachments.some((attachment) => attachment.state._tag === "Preparing");
  const ready = draft.attachments.flatMap((attachment) =>
    attachment.state._tag === "Ready" ? [attachment.state.attachment] : [],
  );
  const comments = draft.comments ?? [];
  const written = text.trim() !== "" || ready.length > 0 || comments.length > 0;
  const sendable = written && !preparing && !connecting && (!isNew || starting.length > 0);
  const canSend = sendable && !needsFolder;
  /** A finished message waits only for a project: sending opens the project list rather than doing nothing. */
  const asksForProject = sendable && needsFolder;

  // `@` tags files in the thread's folder; `$` the skills of the harness the message goes to.
  const sources = {
    folder: target.kind === "thread" ? target.folder : target.mode === "work" ? target.folder : undefined,
    provider: target.kind === "thread" ? target.provider : starting[0]?.provider,
    chat: target.kind === "thread" ? target.folder === undefined : target.mode === "chat",
  };
  // Esc shuts a list for the one `@`, `$` or `/` it was opened by; once that is gone, as when the
  // message is cleared, the next one opens its list again.
  if (
    dismissed !== undefined &&
    (trigger === undefined || trigger.char !== dismissed.char || trigger.start !== dismissed.start)
  ) {
    setDismissed(undefined);
  }
  const menuTrigger =
    trigger !== undefined &&
    trigger.char !== "/" &&
    !(trigger.char === dismissed?.char && trigger.start === dismissed.start)
      ? trigger
      : undefined;
  const results = useMentionOptions(menuTrigger, sources);
  // A `$` that matches no skill is most likely just a dollar sign ("$5"), so its list stays shut.
  const menuOpen =
    menuTrigger !== undefined &&
    (menuTrigger.char === "@" || menuTrigger.query === "" || results.options.length > 0);
  const activeIndex = Math.min(active, Math.max(0, results.options.length - 1));

  // `/` at the start of the message: the user's saved prompts, then the actions that answer here.
  const slashTrigger = trigger?.char === "/" ? trigger : undefined;
  const slashOpen =
    slashTrigger !== undefined &&
    !(slashTrigger.char === dismissed?.char && slashTrigger.start === dismissed.start);
  const storedPrompts = AsyncResult.isSuccess(settings) ? settings.value.prompts.prompts : [];
  const slashPrompts = slashOpen
    ? matchPrompts(visiblePrompts(storedPrompts, sources.folder), slashTrigger?.query ?? "")
    : [];
  // Switching models and stopping the turn live in the box, beside the palette's actions.
  const slashLocal: ReadonlyArray<PaletteCommand> = [
    ...(target.kind === "new"
      ? [
          {
            id: "slash-switch-model",
            group: "Actions" as const,
            label: "Switch model",
            icon: ArrowRightLeft,
            keywords: "model effort speed",
            run: () => setModelsOpen(true),
          },
        ]
      : []),
    ...(running
      ? [
          {
            id: "slash-stop",
            group: "Actions" as const,
            label: "Stop this turn",
            icon: Square,
            keywords: "interrupt cancel halt",
            run: onStop,
          },
        ]
      : []),
  ];
  const slashActions = slashOpen
    ? matchCommands([...slashLocal, ...slashCommands], queryWords(slashTrigger?.query ?? ""))
    : [];
  const slashActive = Math.min(active, Math.max(0, slashPrompts.length + slashActions.length - 1));

  // A long draft, attached files and waiting approvals all grow the box over the transcript's end.
  // An effect rather than a ref callback: reporting re-renders the box, which would re-run the callback.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null || onHeight === undefined) return;
    const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
    observer.observe(element);
    return () => {
      observer.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  // Seated, the box hangs from its seat, so it unfolds downwards, away from the question. Leaving the
  // seat as the thread starts, it drops to the pane's foot rather than jumping there.
  useLayoutEffect(() => {
    const element = box.current;
    const pane = element?.offsetParent;
    if (!element || !(pane instanceof HTMLElement)) return;
    const from = element.getBoundingClientRect().top;
    const top = seat === undefined ? undefined : seat - pane.getBoundingClientRect().top;
    const fits = top !== undefined && top + element.offsetHeight <= pane.clientHeight;
    element.style.top = fits ? `${top}px` : "";
    element.style.bottom = fits ? "auto" : "";
    const drop = from - element.getBoundingClientRect().top;
    if (fits || drop === 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate([{ translate: `0 ${drop}px` }, { translate: "0 0" }], {
      duration: 360,
      easing: "cubic-bezier(0.22, 0.8, 0.24, 1)",
    });
  }, [seat]);

  // Opening a thread, or a new one, puts the cursor where the next message goes.
  const focusOnOpen = useEffectEvent(() => {
    if (takesFocus) input.current?.focus();
  });
  useEffect(() => focusOnOpen(), [input, draftKey]);

  /** How the open thread not started yet starts, the first time the user writes or picks anything in it. */
  const startOf = (current: Draft): DraftStart | undefined =>
    current.start ??
    (target.kind === "new"
      ? startedNow({
          mode: target.mode,
          ...(machine ? { machine: machine.id } : {}),
          ...(target.mode === "work" && target.folder !== undefined ? { folder: target.folder } : {}),
        })
      : undefined);

  const updateDraft = (key: string, update: (current: Draft) => Draft) =>
    setDrafts((current) =>
      withDraft(current, key, (each) => {
        const next = update(each);
        // Only the open draft learns how it starts; a file finishing for another one keeps its own.
        const start = key === draftKey && isNewDraftKey(key) ? startOf(next) : next.start;
        return start ? { ...next, start } : next;
      }),
    );

  /** Remembers a pick in the open new thread's draft; nothing else changes it. */
  const pickForDraft = (
    pick: Partial<
      Pick<
        DraftStart,
        "folder" | "model" | "models" | "effort" | "autoEffort" | "speed" | "access" | "worktree"
      >
    >,
  ) =>
    updateDraft(draftKey, (current) => {
      const start = startOf(current);
      return start ? { ...current, start: { ...start, ...pick } } : current;
    });
  /** Multi agent on, starting from the model picked so far with its list open to add more, or off, back to the first one picked. */
  const setMulti = (on: boolean) => {
    if (on) {
      pickForDraft({ models: model ? [modelKey(model)] : [] });
      setModelsOpen(true);
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
  /** A level picked by hand, which takes the draft off Auto. */
  const setEffort = (value: ReasoningEffort) => {
    setDefaultEffort(value);
    pickForDraft({ effort: value, ...(routerOn ? { autoEffort: false } : {}) });
  };
  const setSpeed = (value: ModelSpeed) => {
    setDefaultSpeed(value);
    pickForDraft({ speed: value });
  };
  const setAccess = (value: AccessMode) => pickForDraft({ access: value });

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

  const setAttachment = (key: string, id: string, state: DraftAttachment["state"]) =>
    updateDraft(key, (current) => ({
      ...current,
      attachments: current.attachments.map((attachment) =>
        attachment.id === id ? { ...attachment, state } : attachment,
      ),
    }));

  /** Attaches pasted, dropped or picked files; each shows at once and is ready once it is on disk. */
  const addFiles = (files: ReadonlyArray<File>) => {
    const key = draftKey;
    for (const file of files) {
      const id = crypto.randomUUID();
      const preview = isPreviewable(file) ? URL.createObjectURL(file) : undefined;
      updateDraft(key, (current) => ({
        ...current,
        attachments: [
          ...current.attachments,
          {
            id,
            name: file.name || "Pasted image",
            mediaType: mediaTypeOf(file),
            ...(preview ? { preview } : {}),
            state: { _tag: "Preparing" },
          },
        ],
      }));
      prepareAttachment(file, (payload) => saveAttachment(registry, id, payload)).then(
        (attachment) => setAttachment(key, id, { _tag: "Ready", attachment }),
        (error: unknown) =>
          setAttachment(key, id, {
            _tag: "Failed",
            message: error instanceof Error ? error.message : `${file.name} couldn't be attached.`,
          }),
      );
    }
  };

  // Files dropped anywhere on the window attach here, not only onto the box: elsewhere the browser
  // would open the file in place of the app. While the box is out of view (settings or another pane
  // over it, which keep its layout but make it inert, or a dialog hiding it), drops are left alone.
  const takeFiles = useEffectEvent((files: ReadonlyArray<File>) => addFiles(files));
  useEffect(() => {
    const showing = () =>
      box.current !== null &&
      box.current.getClientRects().length > 0 &&
      box.current.closest('[inert], [aria-hidden="true"]') === null;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const over = (event: DragEvent) => {
      if (!carriesFiles(event) || !showing()) return;
      event.preventDefault();
      setDragging(true);
    };
    // Leaving for the window's edge; moving between its elements names the one entered.
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      setDragging(false);
      if (!carriesFiles(event) || !showing()) return;
      event.preventDefault();
      takeFiles([...(event.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const removeAttachment = (id: string) => {
    const removed = draft.attachments.find((attachment) => attachment.id === id);
    if (removed?.preview) URL.revokeObjectURL(removed.preview);
    updateDraft(draftKey, (current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.id !== id),
    }));
  };

  const resumes = thread?.ended !== undefined;
  const oneLine = useKeyboardOpen();
  // A message that wraps on the one line opens the box, so it isn't squeezed into the space left
  // beside the controls; it stays open, though the wider line may fit it again, until it's cleared.
  const [grownFor, setGrownFor] = useState<string>();
  const blank = text.trim() === "";
  if (grownFor !== undefined && blank) setGrownFor(undefined);
  const grown = grownFor === draftKey;
  // An open thread's box is one line: attach, the message, then the lead's model and send, until the
  // message outgrows it. A new thread's rests on that line too until the user writes, then unfolds a
  // row for the choices that start it. A touch screen keeps the row out, as the keyboard covers the
  // box while writing.
  const compact = thread !== undefined && !oneLine && !grown;
  useLayoutEffect(() => {
    const element = input.current;
    if (!compact || element === null) return;
    const check = () => {
      const style = getComputedStyle(element);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      if (element.scrollHeight - padding > parseFloat(style.lineHeight) * 1.5) setGrownFor(draftKey);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, draftKey, input]);
  const rests =
    isNew &&
    !oneLine &&
    !touch &&
    !focused &&
    !written &&
    draft.attachments.length === 0 &&
    !needsFolder &&
    !projectsOpen;
  const inline = oneLine || compact || rests;
  // The glass morphs between its one line and its open shape: it grows up from its foot as the message
  // lifts onto a line of its own, and the controls stay on the bottom line.
  const glass = useRef<HTMLDivElement>(null);
  useMorph(glass, inline ? "line" : "open");
  const unfolded = useChanged(inline);

  // Speech becomes text at the caret, transcribed on this computer (features/dictation). The web
  // client is a phone's, whose keyboard has a microphone of its own.
  const dictation = useDictation((spoken) => editor.current?.insertText(spoken));
  const dictates = !WEB && !oneLine && navigator.mediaDevices !== undefined;
  const listening = dictation.state.phase === "recording" || dictation.state.phase === "starting";
  // Another thread's draft never takes what was said for this one.
  const stopDictating = useEffectEvent(() => dictation.cancel());
  useEffect(() => () => stopDictating(), [draftKey]);

  /** Adds text and files to the draft, skipping files it already holds. */
  const appendToDraft: MessageBox["append"] = ({ segments, attachments = [], replacing }) => {
    const key = draftKey;
    updateDraft(key, (current) => {
      const attached = new Set(
        current.attachments.flatMap((attachment) =>
          attachment.state._tag === "Ready" ? [attachment.state.attachment.path] : [],
        ),
      );
      return {
        ...current,
        attachments: [
          ...current.attachments,
          ...attachments
            .filter((attachment) => !attached.has(attachment.path))
            .map((attachment): DraftAttachment => ({
              id: crypto.randomUUID(),
              name: attachment.name,
              mediaType: attachment.mediaType,
              state: { _tag: "Ready", attachment },
            })),
        ],
      };
    });
    editor.current?.append(segments, replacing);
  };

  useImperativeHandle<MessageBox | null, MessageBox | null>(messageBox, () => ({
    mention: (mention) => editor.current?.mentionAtCaret(mention),
    append: appendToDraft,
    comment: ({ quote, text, file }) =>
      updateDraft(draftKey, (current) => ({
        ...current,
        comments: [
          ...(current.comments ?? []),
          { id: crypto.randomUUID(), quote, text, ...(file ? { file } : {}) },
        ],
      })),
    key: () => draftKey,
  }));

  const editComment = (id: string, text: string) =>
    updateDraft(draftKey, (current) => ({
      ...current,
      comments: (current.comments ?? []).map((comment) =>
        comment.id === id ? { ...comment, text } : comment,
      ),
    }));
  const removeComment = (id: string) =>
    updateDraft(draftKey, (current) => {
      const { comments: _, ...rest } = current;
      const kept = current.comments?.filter((comment) => comment.id !== id) ?? [];
      return kept.length > 0 ? { ...rest, comments: kept } : rest;
    });

  const pick = (mention: Mention) => {
    editor.current?.insertMention(mention);
    setActive(0);
  };

  /** A `/` entry: a saved prompt's text in place of the command, or the action run at once. */
  const pickSlash = (entry: SlashEntry) => {
    if (entry.kind === "prompt") editor.current?.replaceTriggerText(entry.prompt.text);
    else entry.command.run();
    setTrigger(undefined);
    setActive(0);
  };

  const send = () => {
    if (asksForProject) {
      setProjectsOpen(true);
      return;
    }
    const setupOf = (each: ModelInfo): ThreadSetup => {
      const level = effortFor(each, activeEffort);
      const pace = speedFor(each, activeSpeed);
      return {
        provider: each.provider,
        model: each.id,
        ...(level ? { effort: level } : {}),
        ...(level && autoEffort ? { autoEffort } : {}),
        ...(pace ? { speed: pace } : {}),
        access: isNew && target.mode === "chat" ? "readOnly" : access,
        ...(worktree ? { worktree } : {}),
      };
    };
    const [first, ...rest] = starting;
    if (!canSend || first === undefined) return;
    const key = draftKey;
    const sent = draft;
    const message = withComments(text, comments);
    // Its text stays where it was written until the transcript shows it and flies it there. One sent
    // behind a running turn waits in the box instead.
    if (!running && input.current) launch(input.current, message);
    setDrafts((current) => withoutDraft(current, key));
    setEpoch((current) => current + 1);
    setTrigger(undefined);
    void onSend({ text: message, attachments: ready, mentions: draftMentions(draft.segments) }, [
      setupOf(first),
      ...rest.map(setupOf),
    ]).then((delivered) => {
      if (delivered) {
        for (const attachment of sent.attachments) {
          if (attachment.preview) URL.revokeObjectURL(attachment.preview);
        }
        return;
      }
      // Give an undelivered message back, unless the user has started writing another.
      setDrafts((current) => (hasContent(current[key]) ? current : { ...current, [key]: sent }));
      setEpoch((current) => current + 1);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = results.options.length;
    if (menuOpen && count > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pick(results.options[activeIndex]!.mention);
        return;
      }
    }
    // The `/` list answers the same keys: arrows move, Enter or Tab runs, Esc closes it.
    const slashCount = slashPrompts.length + slashActions.length;
    if (slashOpen && slashCount > 0 && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((slashActive + (event.key === "ArrowDown" ? 1 : slashCount - 1)) % slashCount);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pickSlash(
          slashActive < slashPrompts.length
            ? { kind: "prompt", prompt: slashPrompts[slashActive]! }
            : { kind: "action", command: slashActions[slashActive - slashPrompts.length]! },
        );
        return;
      }
    }
    if ((menuOpen || slashOpen) && event.key === "Escape") {
      event.preventDefault();
      setDismissed(menuTrigger ?? slashTrigger);
      return;
    }
    if (
      dictates &&
      !isCapturingBinding() &&
      isDictationKey(event, bindingFor(bindings, "dictate"), usesCommandKey())
    ) {
      event.preventDefault();
      dictation.toggle();
      return;
    }
    // Esc while listening drops the recording rather than stopping the turn.
    if (listening && event.key === "Escape") {
      event.preventDefault();
      dictation.cancel();
      return;
    }
    if (isSendKey(event, touch ? "ctrlEnter" : sendKey)) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && running) {
      event.preventDefault();
      onStop();
    }
  };

  const attachButton = (
    <IconButton
      icon={Paperclip}
      label="Attach files"
      onClick={() => filePicker.current?.click()}
      className={
        oneLine
          ? "size-10"
          : inline
            ? "m-1 size-8 rounded-full pointer-coarse:size-10 max-md:size-10"
            : "size-8 rounded-full pointer-coarse:size-10 max-md:size-10"
      }
    />
  );
  // On one line the box keeps focus when sending, so the keyboard stays up for the next message.
  const keepFocus = oneLine ? (event: MouseEvent) => event.preventDefault() : undefined;
  const discSize = oneLine
    ? "m-0.5 size-9"
    : inline
      ? "m-1 size-8 pointer-coarse:size-10 max-md:size-10"
      : "size-8 pointer-coarse:size-10 max-md:size-10";
  // Stop pops in as a turn starts, and send as it ends, once the box has seen one change.
  const turned = useChanged(running);
  const stopButton = (
    <Tooltip label="Stop" shortcut="Esc">
      {/* A ring turns around it while the turn runs, so the one control that ends it stands out. */}
      <Button
        onClick={onStop}
        onMouseDown={keepFocus}
        aria-label="Stop"
        className={`relative grid shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-[opacity,scale,filter] before:absolute ${turned ? "swap-in" : ""} before:-inset-1 before:animate-spin before:rounded-full before:border-[1.5px] before:border-transparent before:border-t-fg-secondary hover:opacity-90 active:scale-95 motion-reduce:before:animate-none ${discSize}`}
      >
        <Square size={11} fill="currentColor" strokeWidth={0} />
      </Button>
    </Tooltip>
  );
  const sendLabel = asksForProject ? "Choose a project first" : running ? "Send after this turn" : "Send";
  const sendButton = (
    <Tooltip
      label={sendLabel}
      {...(touch || asksForProject ? {} : { shortcut: sendKey === "enter" ? "Enter" : "Ctrl Enter" })}
    >
      <Button
        onClick={send}
        onMouseDown={keepFocus}
        disabled={!canSend && !asksForProject}
        aria-label={sendLabel}
        // With nothing to send it's an outlined ring rather than a faded disc, which read as broken.
        className={`grid shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-[opacity,scale,filter,background-color] hover:opacity-90 ${turned ? "swap-in" : ""} active:scale-95 disabled:bg-transparent disabled:text-fg-tertiary disabled:opacity-100 disabled:ring-1 disabled:ring-line-strong disabled:ring-inset ${discSize}`}
      >
        <ArrowUp size={16} strokeWidth={2.25} />
      </Button>
    </Tooltip>
  );
  /** What the model picker shows for an open thread: the model it runs, or the name the transcript gives it. */
  const threadShown: ShownModel | undefined = thread
    ? {
        provider: thread.provider,
        label: threadModel?.label ?? thread.model,
        ...(threadModel ? { key: modelKey(threadModel) } : {}),
      }
    : undefined;

  const placeholder = listening
    ? "Listening…"
    : running
      ? "Queue a follow-up"
      : resumes
        ? thread?.ended === "failed"
          ? "Send a message to try again"
          : "Send a message to pick this thread back up"
        : isNew
          ? starting.length > 1
            ? `Message ${starting.length} models at once`
            : target.mode === "chat"
              ? "Ask anything"
              : "Describe the task"
          : `Message ${threadShown?.label}`;

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
          value: threadAuto ? "auto" : threadEffort,
          auto: routerOn,
          onPick: (next) =>
            switchLead(
              next === "auto"
                ? { model: threadModel.id, autoEffort: true }
                : { model: threadModel.id, effort: next, ...(threadAuto ? { autoEffort: false } : {}) },
            ),
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
  const threadChip =
    thread && threadShown ? (
      handoff || switchesModel || threadEffortChoice || offersSpeed(threadSpeedChoice) || onCompact ? (
        <ModelPicker
          models={
            handoff
              ? [...ownModels, ...models.filter((each) => each.provider !== thread.provider)]
              : ownModels
          }
          shown={threadShown}
          providers={handoff ? providers : [thread.provider]}
          available={new Set([thread.provider, ...(handoff?.available ?? [])])}
          effort={threadEffortChoice}
          effortShown={threadEffortShown}
          speed={threadSpeedChoice}
          speedShown={threadSpeed}
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

  // A new thread's model and effort, the same chip; a level picked by hand takes it off Auto.
  const newEffortShown: EffortPick | undefined = activeEffort
    ? autoEffort
      ? "auto"
      : activeEffort
    : undefined;
  const newEffortChoice: EffortChoice | undefined = activeEffort
    ? {
        levels: efforts,
        value: autoEffort ? "auto" : activeEffort,
        auto: routerOn,
        onPick: (next) => (next === "auto" ? pickForDraft({ autoEffort: true }) : setEffort(next)),
      }
    : undefined;
  const newSpeedChoice: SpeedChoice = { speeds, value: activeSpeed ?? "standard", onPick: setSpeed };
  const newChip =
    target.kind === "new" ? (
      multi ? (
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
          onPick={(keys) => pickForDraft({ models: keys })}
          onSingle={() => setMulti(false)}
          // Agents that may edit share the one folder, where they can undo each other's work.
          {...(target.mode === "work" && !worktree && access !== "readOnly" && starting.length > 1
            ? { note: "They share the folder, so their edits can collide" }
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
          onPick={(picked) => setModelId(modelKey(picked))}
        />
      )
    ) : null;

  // What's seldom changed waits behind one button: access, shown on it once it isn't Auto, and
  // several models at once.
  const moreMenu =
    target.kind === "new" ? (
      <MoreMenu
        {...(target.mode === "work" ? { access: { value: access, onPick: setAccess, limit } } : {})}
        {...(models.filter((each) => target.available.has(each.provider)).length > 1
          ? { several: { on: multi, onChange: setMulti } }
          : {})}
      />
    ) : null;

  /** Access other than Auto stays in sight while the box rests and its setup row is folded away. */
  const restingAccess = rests && target.kind === "new" && target.mode === "work" && access !== "auto";

  // While a turn runs, a message written meanwhile waits for it to end, so send stays beside stop. The
  // model chip leads the right-hand group with access after it, what the message goes to and how it
  // may act; dictation sits by send, both being how the message is written and sent.
  const actions = (
    <div className="flex min-w-0 shrink-0 items-center gap-1">
      {oneLine ? null : thread ? threadChip : newChip}
      {!inline || restingAccess ? moreMenu : null}
      {dictates ? <DictationControl dictation={dictation} /> : null}
      {running ? stopButton : null}
      {running && !written ? null : sendButton}
    </div>
  );

  // Where a new work thread runs, as a path (project / branch or new worktree), leading the setup row.
  const newPlace =
    target.kind === "new" && target.mode === "work" ? (
      <div className={`flex min-w-0 items-center ${unfolded ? "write-in [--write-delay:90ms]" : ""}`}>
        <ProjectPicker
          folder={target.folder}
          open={projectsOpen}
          onOpenChange={setProjectsOpen}
          needed={asksForProject}
          returnFocus={input}
          onChoose={(folder) => {
            target.onChooseFolder(folder);
            pickForDraft({ folder });
          }}
        />
        {gitFolder !== undefined && branch !== undefined ? (
          <>
            <span aria-hidden className="text-meta text-fg-disabled">
              /
            </span>
            <WorktreePicker
              branch={branch}
              value={worktree}
              onPick={(picked) => {
                setWorkplace(picked ? "worktree" : "local");
                pickForDraft({ worktree: picked });
              }}
            />
          </>
        ) : null}
      </div>
    ) : null;

  return (
    <div
      ref={box}
      className={`pointer-events-none absolute inset-x-0 bottom-0 px-3 md:px-8 md:pb-5 ${
        oneLine ? "pb-2" : "pb-[max(env(safe-area-inset-bottom),0.75rem)]"
      }`}
    >
      {above}
      <Reveal>
        {thread && low && lowTarget ? (
          <LowLimitNotice
            from={thread.provider}
            meter={low.meter}
            level={low.level}
            target={lowTarget}
            now={now}
            onContinue={() => askHandoff(lowTarget)}
          />
        ) : null}
      </Reveal>
      {handoff ? (
        <HandoffDialog
          handoff={handingOff}
          running={running}
          agents={handoff.agents}
          onOpenChange={(open) => {
            if (!open) setHandingOff(undefined);
          }}
          onConfirm={() => (handingOff ? handoff.onHandOff(handingOff.choice) : Promise.resolve(false))}
        />
      ) : null}
      {/* The list sits beside the box, not in it: inside the box's own blur it couldn't blur what's behind. */}
      <div
        className="relative mx-auto max-w-[46.2rem]"
        onFocus={(event) => {
          focusMoves.current += 1;
          if (event.target === input.current) setFocused(true);
        }}
        onBlur={() => {
          const moves = focusMoves.current;
          requestAnimationFrame(() => {
            if (focusMoves.current === moves) setFocused(false);
          });
        }}
      >
        {menuOpen ? (
          <MentionMenu
            trigger={menuTrigger}
            sources={sources}
            results={results}
            active={activeIndex}
            onActive={setActive}
            onPick={pick}
          />
        ) : null}
        {slashOpen ? (
          <SlashMenu
            groups={slashGroups(slashPrompts, slashActions)}
            query={slashTrigger?.query ?? ""}
            active={slashActive}
            onActive={setActive}
            onPick={pickSlash}
          />
        ) : null}
        {/* A film a step above the conversation's own: the box stands apart by that, its edge and the
            blur of what scrolls under it, never as a dark slab over the glass. */}
        <div
          ref={glass}
          className={`pointer-events-auto relative border bg-surface-film shadow-film backdrop-blur-2xl transition-colors ${
            dragging ? "border-accent" : "border-line-strong"
          } ${inline ? "flex flex-wrap items-end rounded-[24px] p-1" : "rounded-[18px]"}`}
        >
          {dragging ? (
            <div className="pointer-events-none absolute inset-1.5 z-10 grid place-items-center rounded-[13px] border-[1.5px] border-dashed border-line-strong bg-surface-panel text-body text-fg-secondary backdrop-blur-xl">
              <span className="flex items-center gap-2">
                <Paperclip size={14} strokeWidth={1.75} />
                Drop to attach
              </span>
            </div>
          ) : null}
          {/* The editor keeps its place in the tree as the layout changes: remounting it would drop
              focus, and the keyboard with it. */}
          {dictates ? <DictationNotice dictation={dictation} /> : null}
          {/* Each tray grows the box as it comes and folds away as it goes. min-w-0: a tray's
              truncated lines would otherwise widen it past the one-line box. */}
          <Reveal className={inline ? "min-w-0 basis-full" : ""}>
            {queue ? (
              <QueueTray
                queue={queue}
                onEdit={(message) =>
                  appendToDraft({
                    segments: segmentsOf(message.text, message.mentions),
                    attachments: message.attachments,
                  })
                }
              />
            ) : null}
          </Reveal>
          <Reveal className={inline ? "min-w-0 basis-full" : ""}>
            {comments.length > 0 ? (
              <CommentTray comments={comments} onEdit={editComment} onRemove={removeComment} />
            ) : null}
          </Reveal>
          <Reveal className={inline ? "min-w-0 basis-full" : ""}>
            {draft.attachments.length > 0 ? (
              <AttachmentTray attachments={draft.attachments} onRemove={removeAttachment} />
            ) : null}
          </Reveal>
          {inline ? attachButton : null}
          <PromptEditor
            inline={inline}
            ref={input}
            handle={editor}
            resetKey={`${draftKey}:${epoch}`}
            segments={draft.segments}
            placeholder={placeholder}
            onChange={(segments) => updateDraft(draftKey, (current) => ({ ...current, segments }))}
            onTrigger={(next) => {
              if (!sameTrigger(next, trigger)) setActive(0);
              setTrigger(next);
            }}
            onKeyDown={onKeyDown}
            onFiles={addFiles}
            activeOption={
              menuOpen && results.options.length > 0
                ? `mention-option-${activeIndex}`
                : slashOpen && slashPrompts.length + slashActions.length > 0
                  ? `slash-option-${slashActive}`
                  : undefined
            }
            // While the lead works and nothing is written, the line says what it's doing.
            cover={compact && running ? activity : undefined}
          />
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          {/* One line, or a new thread's setup row under the message once the user writes. */}
          {inline ? (
            actions
          ) : (
            <div className="flex items-end gap-1 px-2 pt-1 pb-2">
              {/* The row's choices wrap among themselves on a narrow screen, so send keeps its
                  corner instead of dropping onto a row of its own. Unfolding, where the thread will
                  run writes itself out after the paperclip. */}
              <div className="flex min-h-8 min-w-0 flex-1 flex-wrap content-center items-center gap-0.5">
                {attachButton}
                {newPlace}
              </div>
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
