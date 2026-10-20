import { Button } from "@base-ui/react/button";
import {
  OFFERED_PROVIDERS,
  type AccessMode,
  type Attachment,
  type Mention,
  type ModelInfo,
  type ProviderId,
  type ReasoningEffort,
} from "@cerium/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowUp, Gauge, Paperclip, Square } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { manifestsAtom } from "../../backend/atoms.ts";
import { saveAttachment } from "../../backend/files.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useKeyboardOpen } from "../../web/viewport.ts";
import { gitBranchAtom } from "../../backend/projects.ts";
import {
  accessAtom,
  effortAtom,
  isSendKey,
  modelAtom,
  sendKeyAtom,
  workplaceAtom,
} from "../settings/preferences.ts";
import { providerName } from "../threads/model.ts";
import { AttachmentTray } from "./AttachmentTray.tsx";
import { isPreviewable, mediaTypeOf, prepareAttachment } from "./attachments.ts";
import {
  draftMentions,
  draftText,
  emptyDraft,
  hasContent,
  type Draft,
  type DraftAttachment,
  type DraftStart,
  type Trigger,
} from "./draft.ts";
import { draftsAtom, isNewDraftKey, startedNow, withDraft, withoutDraft } from "./drafts.ts";
import { MentionMenu, useMentionOptions } from "./MentionMenu.tsx";
import type { MessageBox } from "./messageBox.ts";
import {
  effortFor,
  effortLabel,
  effortsOf,
  MAX_AGENTS,
  modelKey,
  pickModel,
  pickModels,
  switchTo,
  useModels,
  type ModelSwitch,
} from "./models.ts";
import { ModelPicker, ModelsPicker, type ShownModel } from "./ModelPicker.tsx";
import { AccessPicker, EffortPicker, FixedChip } from "./Pickers.tsx";
import { useCoarsePointer } from "./pointer.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor.tsx";
import { WorktreeChip, WorktreePicker } from "./WorktreePicker.tsx";

const providers = OFFERED_PROVIDERS;
const allProviders: ReadonlySet<ProviderId> = new Set(providers);

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
      /** The thread's folder, which `@` tags files from; absent for chats. */
      readonly folder?: string | undefined;
      /** The thread's own worktree's branch, and the branch it was made from. */
      readonly worktree?: { readonly branch: string; readonly base: string } | undefined;
      /** The lead stopped or failed; the next message picks the thread back up. */
      readonly ended?: "stopped" | "failed";
      /**
       * Switches the lead to another model of its harness, or another effort, from its next turn.
       * Resolves false when it didn't go through. Absent where the box can't ask for that.
       */
      readonly onSwitch?: (choice: ModelSwitch) => Promise<boolean>;
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
}: ComposerProps) {
  const [drafts, setDrafts] = useAtom(draftsAtom);
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
  const save = useAtomSet(saveAttachment, { mode: "promise" });
  const draft = drafts[draftKey] ?? emptyDraft;
  // New threads start with the model and effort the last one was given, which are also the defaults
  // in settings. Access always starts from the settings default. A pick here stays with the draft.
  const [defaultModel, setDefaultModel] = useAtom(modelAtom);
  const [defaultEffort, setDefaultEffort] = useAtom(effortAtom);
  const defaultAccess = useAtomValue(accessAtom);
  const modelId = draft.start?.model ?? defaultModel;
  const effort = draft.start?.effort ?? defaultEffort;
  const access = draft.start?.access ?? defaultAccess;
  const [workplace, setWorkplace] = useAtom(workplaceAtom);
  /** A worktree is offered for a work thread in a folder git keeps, on a machine that makes them. */
  const gitFolder =
    target.kind === "new" && target.mode === "work" && target.worktrees === true ? target.folder : undefined;
  const branch = AsyncResult.getOrElse(useAtomValue(gitBranchAtom(gitFolder ?? "")), () => undefined);
  const worktree =
    gitFolder !== undefined && branch !== undefined && (draft.start?.worktree ?? workplace === "worktree");
  const sendKey = useAtomValue(sendKeyAtom);
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
  /** One effort for every model starting; each model that lacks it runs at its own default. */
  const efforts = effortsOf(starting);
  // Keep the effort valid when switching to a model with fewer levels.
  const activeEffort =
    multi && effort !== undefined && efforts.includes(effort)
      ? effort
      : starting.map((each) => effortFor(each, effort)).find((each) => each !== undefined);
  const [modelsOpen, setModelsOpen] = useState(false);
  const needsFolder = isNew && target.mode === "work" && target.folder === undefined;
  const text = draftText(draft.segments);
  const preparing = draft.attachments.some((attachment) => attachment.state._tag === "Preparing");
  const ready = draft.attachments.flatMap((attachment) =>
    attachment.state._tag === "Ready" ? [attachment.state.attachment] : [],
  );
  const written = text.trim() !== "" || ready.length > 0;
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
  const menuTrigger =
    trigger !== undefined && !(trigger.char === dismissed?.char && trigger.start === dismissed.start)
      ? trigger
      : undefined;
  const results = useMentionOptions(menuTrigger, sources);
  // A `$` that matches no skill is most likely just a dollar sign ("$5"), so its list stays shut.
  const menuOpen =
    menuTrigger !== undefined &&
    (menuTrigger.char === "@" || menuTrigger.query === "" || results.options.length > 0);
  const activeIndex = Math.min(active, Math.max(0, results.options.length - 1));

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
    pick: Partial<Pick<DraftStart, "folder" | "model" | "models" | "effort" | "access" | "worktree">>,
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
  const setEffort = (value: ReasoningEffort) => {
    setDefaultEffort(value);
    pickForDraft({ effort: value });
  };
  const setAccess = (value: AccessMode) => pickForDraft({ access: value });

  // An open thread's lead can take another model of its harness, or another effort, when the harness
  // can switch a session. A machine too old to say (it has no manifests) offers nothing to switch.
  const thread = target.kind === "thread" ? target : undefined;
  const manifests = useAtomValue(manifestsAtom);
  const switching =
    thread?.onSwitch !== undefined && AsyncResult.isSuccess(manifests)
      ? manifests.value.find((manifest) => manifest.provider === thread.provider)?.switching
      : undefined;
  /** A pick the machine hasn't confirmed yet, which holds only while the thread still has what it was made against. */
  const [pending, setPending] = useState<{ readonly base: string; readonly choice: ModelSwitch }>();
  const base = `${draftKey}|${thread?.modelId}|${thread?.effort}`;
  const picked = pending?.base === base ? pending.choice : undefined;
  const threadModel =
    thread === undefined
      ? undefined
      : models.find(
          (candidate) =>
            candidate.provider === thread.provider && candidate.id === (picked?.model ?? thread.modelId),
        );
  const threadEffort = threadModel
    ? effortFor(threadModel, picked ? picked.effort : thread?.effort)
    : undefined;
  const switchLead = (choice: ModelSwitch) => {
    if (thread?.onSwitch === undefined) return;
    setPending({ base, choice });
    void thread.onSwitch(choice).then((done) => {
      // A refusal undoes only its own pick, not one made since.
      if (!done) setPending((current) => (current?.choice === choice ? undefined : current));
    });
  };

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
      prepareAttachment(file, (payload) => save({ payload })).then(
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

  useImperativeHandle<MessageBox | null, MessageBox | null>(messageBox, () => ({
    mention: (mention) => editor.current?.mentionAtCaret(mention),
    append: ({ segments, attachments = [], replacing }) => {
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
    },
  }));

  const pick = (mention: Mention) => {
    editor.current?.insertMention(mention);
    setActive(0);
  };

  const send = () => {
    if (asksForProject) {
      setProjectsOpen(true);
      return;
    }
    const setupOf = (each: ModelInfo): ThreadSetup => {
      const level = effortFor(each, activeEffort);
      return {
        provider: each.provider,
        model: each.id,
        ...(level ? { effort: level } : {}),
        access: isNew && target.mode === "chat" ? "readOnly" : access,
        ...(worktree ? { worktree } : {}),
      };
    };
    const [first, ...rest] = starting;
    if (!canSend || first === undefined) return;
    const key = draftKey;
    const sent = draft;
    setDrafts((current) => withoutDraft(current, key));
    setEpoch((current) => current + 1);
    setTrigger(undefined);
    void onSend({ text: text.trim(), attachments: ready, mentions: draftMentions(draft.segments) }, [
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
    if (menuOpen && event.key === "Escape") {
      event.preventDefault();
      setDismissed(menuTrigger);
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
      {...(oneLine ? { className: "size-10" } : {})}
    />
  );
  // On one line the box keeps focus when sending, so the keyboard stays up for the next message.
  const keepFocus = oneLine ? (event: MouseEvent) => event.preventDefault() : undefined;
  const discSize = oneLine ? "m-0.5 size-9" : "size-8";
  const stopButton = (
    <Tooltip label="Stop" shortcut="Esc">
      <Button
        onClick={onStop}
        onMouseDown={keepFocus}
        aria-label="Stop"
        className={`grid shrink-0 place-items-center rounded-full bg-surface-active text-fg-primary transition-colors hover:bg-line-strong ${discSize}`}
      >
        <Square size={12} fill="currentColor" />
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
        className={`grid shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:opacity-30 ${discSize}`}
      >
        <ArrowUp size={16} strokeWidth={2.25} />
      </Button>
    </Tooltip>
  );
  // While a turn runs, a message written meanwhile waits for it to end, so send stays beside stop.
  const actions = running ? (
    <div className="flex shrink-0 items-center gap-1">
      {stopButton}
      {written ? sendButton : null}
    </div>
  ) : (
    sendButton
  );

  /** What the model picker shows for an open thread: the model it runs, or the name the transcript gives it. */
  const threadShown: ShownModel | undefined = thread
    ? {
        provider: thread.provider,
        label: threadModel?.label ?? thread.model,
        ...(threadModel ? { key: modelKey(threadModel) } : {}),
      }
    : undefined;

  const placeholder = resumes
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

  const threadSetup =
    thread && threadShown ? (
      <>
        {switching?.model ? (
          <ModelPicker
            models={models}
            shown={threadShown}
            providers={[thread.provider]}
            available={new Set([thread.provider])}
            onPick={(picked) => switchLead(switchTo(picked, threadEffort, switching.effort))}
            {...(running ? { note: "Applies from the next turn" } : {})}
          />
        ) : (
          <FixedChip
            tip={
              AsyncResult.isFailure(manifests)
                ? "Update Cerium on that computer to switch models"
                : switching
                  ? `${providerName[thread.provider]} can't switch models mid-thread`
                  : "The model this thread started with"
            }
          >
            <ProviderLogo provider={thread.provider} size={13} />
            <span className="font-medium text-fg-primary">{threadShown.label}</span>
          </FixedChip>
        )}
        {threadModel && threadEffort ? (
          switching?.effort ? (
            <EffortPicker
              efforts={threadModel.efforts}
              value={threadEffort}
              onPick={(next) => switchLead({ model: threadModel.id, effort: next })}
            />
          ) : (
            <FixedChip tip="The effort this thread started with">
              <Gauge size={13} strokeWidth={1.75} />
              {effortLabel[threadEffort]}
            </FixedChip>
          )
        ) : null}
        {thread.worktree ? <WorktreeChip {...thread.worktree} /> : null}
      </>
    ) : null;

  // A new thread's setup splits in two: what runs sits in the box, beside the message; where it
  // runs and what it may do sit just under the box, so the box's own row stays uncrowded.
  const newSetup =
    target.kind === "new" ? (
      <>
        {multi ? (
          <ModelsPicker
            models={models}
            chosen={starting}
            providers={providers}
            available={target.available}
            max={MAX_AGENTS}
            open={modelsOpen}
            onOpenChange={setModelsOpen}
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
            onPick={(picked) => setModelId(modelKey(picked))}
            {...(models.filter((each) => target.available.has(each.provider)).length > 1
              ? { onMulti: () => setMulti(true) }
              : {})}
          />
        )}
        {activeEffort ? <EffortPicker efforts={efforts} value={activeEffort} onPick={setEffort} /> : null}
      </>
    ) : null;

  const newPlace =
    target.kind === "new" && target.mode === "work" ? (
      <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-0.5 px-2 pt-1">
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
          <WorktreePicker
            branch={branch}
            value={worktree}
            onPick={(picked) => {
              setWorkplace(picked ? "worktree" : "local");
              pickForDraft({ worktree: picked });
            }}
          />
        ) : null}
        <div className="ml-auto">
          <AccessPicker value={access} onPick={setAccess} />
        </div>
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
      {/* The list sits beside the box, not in it: inside the box's own blur it couldn't blur what's behind. */}
      <div className="relative mx-auto max-w-[46.2rem]">
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
        <div
          className={`pointer-events-auto relative rounded-2xl border bg-surface-raised backdrop-blur-2xl transition-colors ${
            dragging ? "border-accent" : "border-line-subtle focus-within:border-line-strong"
          } ${oneLine ? "flex flex-wrap items-end p-1" : ""}`}
        >
          {dragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-surface-overlay text-[13px] text-fg-secondary backdrop-blur-xl">
              <span className="flex items-center gap-2">
                <Paperclip size={14} strokeWidth={1.75} />
                Drop to attach
              </span>
            </div>
          ) : null}
          {/* The editor keeps its place in the tree as the layout changes: remounting it would drop
              focus, and the keyboard with it. */}
          {draft.attachments.length > 0 ? (
            <div className={oneLine ? "basis-full" : undefined}>
              <AttachmentTray attachments={draft.attachments} onRemove={removeAttachment} />
            </div>
          ) : null}
          {oneLine ? attachButton : null}
          <PromptEditor
            inline={oneLine}
            ref={input}
            handle={editor}
            resetKey={`${draftKey}:${epoch}`}
            segments={draft.segments}
            placeholder={placeholder}
            onChange={(segments) => updateDraft(draftKey, (current) => ({ ...current, segments }))}
            onTrigger={(next) => {
              if (
                next?.char !== trigger?.char ||
                next?.start !== trigger?.start ||
                next?.query !== trigger?.query
              ) {
                setActive(0);
              }
              setTrigger(next);
            }}
            onKeyDown={onKeyDown}
            onFiles={addFiles}
            activeOption={
              menuOpen && results.options.length > 0 ? `mention-option-${activeIndex}` : undefined
            }
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
          {/* While a phone's keyboard is up the setup waits below it; the box is one line. */}
          {oneLine ? (
            actions
          ) : (
            <div className="flex items-end gap-1 px-2 pb-2">
              {/* The pickers wrap among themselves on a narrow screen, so send keeps its corner
                  instead of dropping onto a row of its own. */}
              <div className="flex min-h-8 min-w-0 flex-1 flex-wrap content-center items-center gap-0.5">
                {attachButton}
                {thread ? threadSetup : newSetup}
              </div>
              {actions}
            </div>
          )}
        </div>
        {oneLine ? null : newPlace}
      </div>
    </div>
  );
}
