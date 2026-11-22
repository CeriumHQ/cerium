import { Button } from "@base-ui/react/button";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cloud, Monitor, Paperclip } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import { machineAtom } from "../../backend/machine.ts";
import { Reveal } from "../../components/Reveal.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { useChanged, useMorph } from "../../lib/motion.ts";
import { useCompact } from "../../app/compact.ts";
import { useKeyboardOpen } from "../../web/viewport.ts";
import { usesCommandKey } from "../../lib/keys.ts";
import { bindingFor, isCapturingBinding, matchesBinding, shortcutBindingsAtom } from "../../lib/shortcuts.ts";
import { type PaletteCommand } from "../palette/palette.ts";
import { WEB } from "../../backend/target.ts";
import { DictationControl, DictationNotice } from "../dictation/DictationControl.tsx";
import { useDictation } from "../dictation/useDictation.ts";
import { isSendKey, sendKeyAtom } from "../settings/preferences.ts";
import { AttachmentTray } from "./AttachmentTray.tsx";
import { BackgroundTray, type Background } from "./BackgroundTray.tsx";
import { CommentTray } from "./CommentTray.tsx";
import {
  segmentsOf,
  emptyDraft,
  type Draft,
  type DraftAttachment,
  type DraftStart,
  type Segment,
} from "./draft.ts";
import { draftAtom, draftsAtom, isNewDraftKey, startedNow, withDraft } from "./drafts.ts";
import type { MessageBox, SideQuestionDraft } from "./messageBox.ts";
import { useFollowup } from "./useFollowup.ts";
import { HandoffDialog, LowLimitNotice } from "./HandoffDialog.tsx";
import { AccessMenu } from "./Pickers.tsx";
import { useCoarsePointer } from "./pointer.ts";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor.tsx";
import { recalledPrompt, stepPromptHistory, type BrowsingHistory } from "./promptHistory.ts";
import { SideQuestion } from "./SideQuestion.tsx";
import { QueueTray, type Queue } from "./QueueTray.tsx";

import { leadModelChip, startModelChip } from "./ComposerModelChips.tsx";
import { ComposerProjectControls } from "./ComposerProjectControls.tsx";
import type { ComposerCommands, ComposerTarget, OutgoingMessage, ThreadSetup } from "./composerTypes.ts";
import { useComposerActions } from "./useComposerActions.tsx";
import { useComposerAttachments } from "./useComposerAttachments.ts";
import { useComposerMenus } from "./useComposerMenus.tsx";
import { useComposerSubmission } from "./useComposerSubmission.ts";
import { useLeadSwitch } from "./useLeadSwitch.ts";
import { useStartChoices } from "./useStartChoices.ts";

export type { ComposerCommands, ComposerTarget, OutgoingMessage, ThreadSetup } from "./composerTypes.ts";
/**
 * The dictate binding starts and stops dictation, which no browser or Windows key takes in a text
 * box. Control stays the Control key itself, even on a Mac where ⌘M minimizes (lib/shortcuts.ts).
 */
const isDictationKey = (event: KeyboardEvent<HTMLDivElement>, binding: string, mac: boolean) =>
  matchesBinding(event, binding, mac);

/** The thread's machine can't take messages now: what's sent waits on this device until it can. */
export interface ComposerOutbox {
  /** Its machine is being reached again, can't be, or the thread is the cloud copy of another's. */
  readonly state: "reconnecting" | "offline" | "cloud";
  /** The name of the machine the messages wait for. */
  readonly machine?: string | undefined;
  /** Opens what the window knows of the connection; absent where nothing does. */
  readonly onOpenConnection?: (() => void) | undefined;
}

interface ComposerProps {
  readonly target: ComposerTarget;
  /** Which draft the box shows: each thread, and each thread not started yet, keeps its own. */
  readonly draftKey: string;
  /** The thread's machine hasn't answered yet: the box takes writing, and sending waits for it. */
  readonly connecting?: boolean;
  /** Sending queues instead: the thread's machine can't be reached, so stopping a turn can't either. */
  readonly outbox?: ComposerOutbox | undefined;
  /** The message box, for callers that move focus to it. */
  readonly inputRef?: RefObject<HTMLDivElement | null>;
  /** Filled with what others can put into the box; null while it takes no messages. */
  readonly messageBox?: Ref<MessageBox | null>;
  readonly commands?: Ref<ComposerCommands | null>;
  readonly promptHistory?: () => ReadonlyArray<ReadonlyArray<Segment>>;
  /** A turn is in progress: the send button becomes stop. */
  readonly running: boolean;
  /**
   * Resolves false when the message didn't go through, so the box can give the draft back. A new
   * thread starts with the first setup; multi agent starts one more thread with each of the rest.
   */
  readonly onSend: (
    message: OutgoingMessage,
    setups: readonly [ThreadSetup, ...Array<ThreadSetup>],
    taskId: string | undefined,
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
  /** Hands the lead its queued messages after a successful send. */
  readonly onSteer?: (() => void) | undefined;
  /** The work the thread's agents run in the background, above the queue. */
  readonly background?: Background | undefined;
  /** The thread's agents using the user's computer, above everything else in the box. */
  readonly computer?: ReactNode;
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
  outbox,
  inputRef,
  messageBox,
  commands,
  promptHistory,
  running: turnRunning,
  onSend,
  onStop,
  above,
  onHeight,
  takesFocus = true,
  activity,
  queue,
  onSteer,
  background,
  computer,
  slashCommands = [],
  seat,
}: ComposerProps) {
  const queueing = outbox !== undefined;
  // No turn can be stopped on a machine that can't be reached.
  const running = turnRunning && !queueing;
  const setDrafts = useAtomSet(draftsAtom);
  const machine = useAtomValue(machineAtom);
  /** Bumped when the box itself replaces a draft (sent, or given back), so the editor shows it. */
  const [epoch, setEpoch] = useState(0);
  const ownRef = useRef<HTMLDivElement>(null);
  const input = inputRef ?? ownRef;
  const editor = useRef<PromptEditorHandle>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  /**
   * Writing in the box, or using what it opened, which unfolds a new thread's setup row. Focus that
   * moves among the box's controls and their menus (portalled, but still under the box in React's
   * tree) keeps it; focus that leaves for good folds it, a frame later.
   */
  const [focused, setFocused] = useState(takesFocus);
  const focusMoves = useRef(0);
  const storedDraft = useAtomValue(draftAtom(draftKey)) ?? emptyDraft;
  const [recall, setRecall] = useState<{ key: string; history: BrowsingHistory }>();
  const history =
    recall?.key === draftKey && recall.history.draft === storedDraft.segments ? recall.history : undefined;
  if (recall !== undefined && history === undefined) setRecall(undefined);
  const draft = history === undefined ? storedDraft : { ...storedDraft, segments: recalledPrompt(history) };
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
  const sendKey = useAtomValue(sendKeyAtom);
  const bindings = useAtomValue(shortcutBindingsAtom);
  const touch = useCoarsePointer();
  const narrow = useCompact();
  const [modelsOpen, setModelsOpen] = useState(false);
  const start = useStartChoices({
    target,
    draft,
    draftKey,
    connecting,
    updateDraft,
    startOf,
    onOpenModels: () => setModelsOpen(true),
  });
  const { isNew, starting } = start;
  const lead = useLeadSwitch({ target, draftKey, models: start.models, routerOn: start.routerOn, running });
  const { thread, threadShown, handoff, handingOff, setHandingOff, askHandoff, low, lowTarget, now } = lead;
  const menus = useComposerMenus({
    target,
    draft,
    draftKey,
    storedDraft,
    browsing: history !== undefined,
    editor,
    input,
    start,
    bindings,
    running,
    onStop,
    slashCommands,
    offersSwitch: lead.offersSwitch,
    onOpenModels: () => setModelsOpen(true),
  });
  const { filling } = menus;
  /** The side question's pop-over: a new `id` each time it opens, so nothing of the last one stays. */
  const [side, setSide] = useState<
    SideQuestionDraft & {
      readonly id: number;
      readonly draftKey: string;
      readonly open: boolean;
    }
  >();
  const openSide: MessageBox["openSide"] = (draft) => {
    if (target.kind !== "thread" || target.onAskSide === undefined) return;
    setSide((current) => ({ ...draft, id: (current?.id ?? 0) + 1, draftKey, open: true }));
  };
  if (side !== undefined && (side.draftKey !== draftKey || target.kind !== "thread" || !target.onAskSide)) {
    setSide(undefined);
  }
  const { text, comments, written, blankBox, needsFolder, canSend, asksForProject, send, steerNow } =
    useComposerSubmission({
      target,
      draft,
      draftKey,
      connecting,
      filling: filling !== undefined,
      start,
      input,
      // A queued message doesn't fly to the transcript: it lands in the tray.
      running: running || queueing,
      queue,
      onSend,
      onSteer,
      openSide,
      onChooseProject: () => setProjectsOpen(true),
      onClear: () => {
        setRecall(undefined);
        setEpoch((current) => current + 1);
        menus.clearTrigger();
      },
      onRestore: () => setEpoch((current) => current + 1),
    });
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

  const restoreEditorFocus = () => {
    if (focused) input.current?.focus({ preventScroll: true });
  };
  const { addFiles, removeAttachment, dragging } = useComposerAttachments({
    draftKey,
    attachments: draft.attachments,
    box,
    updateDraft,
    restoreEditorFocus,
  });
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
  // The glass carries the message, controls and trays between the one-line and open shapes.
  const glass = useRef<HTMLDivElement>(null);
  const failedFiles = draft.attachments.filter((attachment) => attachment.state._tag === "Failed").length;
  const morphing = useMorph(glass, inline ? "line" : "open", {
    layout: `${comments.length}:${draft.attachments.length}:${failedFiles}`,
  });
  const unfolded = useChanged(inline);

  // Speech becomes text at the caret, transcribed on this computer (features/dictation). The web
  // client is a phone's, whose keyboard has a microphone of its own.
  const dictation = useDictation((spoken) => editor.current?.insertText(spoken));
  const dictates = !WEB && !oneLine && navigator.mediaDevices !== undefined;
  const listening = dictation.state.phase === "recording" || dictation.state.phase === "starting";
  // A line the user could send next, in the empty box after the lead finishes a turn in view.
  const followup = useFollowup({
    followup: target.kind === "thread" ? target.followup : undefined,
    empty: blankBox && !listening,
    running,
  });
  const suggestion = followup.text;
  const acceptSuggestion = () => {
    if (suggestion === undefined) return;
    followup.dismiss();
    editor.current?.insertText(suggestion);
  };
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
    openSide,
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const composing = event.nativeEvent.isComposing;
    if (
      !composing &&
      !isCapturingBinding() &&
      matchesBinding(event, bindingFor(bindings, "steer-now"), usesCommandKey())
    ) {
      if (event.repeat || steerNow()) event.preventDefault();
      return;
    }
    const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    // The suggestion answers only a plain Tab, which then writes it as ordinary text, and Esc, which
    // drops it. Shift Tab, a composing IME and every other key go on as they would.
    if (!event.nativeEvent.isComposing) {
      if (
        suggestion !== undefined &&
        event.key === "Tab" &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        acceptSuggestion();
        return;
      }
      if (event.key === "Escape") {
        followup.dismiss();
        if (suggestion !== undefined) {
          event.preventDefault();
          return;
        }
      }
    }
    if (menus.onKeyDown(event, plain)) return;
    if (
      thread?.onAskSide &&
      !isCapturingBinding() &&
      matchesBinding(event, bindingFor(bindings, "side-question"), usesCommandKey())
    ) {
      event.preventDefault();
      openSide();
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
    if (!composing && plain && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const blocked = menus.open || suggestion !== undefined || filling !== undefined || listening;
      const atStart = history !== undefined || editor.current?.atStart() === true;
      const step = stepPromptHistory({
        direction: event.key === "ArrowUp" ? "older" : "newer",
        history,
        entries:
          !blocked && history === undefined && blankBox && atStart && event.key === "ArrowUp"
            ? (promptHistory?.() ?? [])
            : [],
        draft: storedDraft.segments,
        atStart,
        empty: blankBox,
        blocked,
      });
      if (step !== undefined) {
        event.preventDefault();
        setRecall(step.history === undefined ? undefined : { key: draftKey, history: step.history });
        menus.clearTrigger();
        return;
      }
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
      onClick={() => {
        restoreEditorFocus();
        filePicker.current?.click();
      }}
      className={
        oneLine
          ? "size-10"
          : inline
            ? "m-1 size-8 rounded-full pointer-coarse:size-10 max-md:size-10"
            : "size-8 rounded-full pointer-coarse:size-10 max-md:size-10"
      }
    />
  );
  // Where the messages wait to go, for a thread whose machine is away rather than coming back.
  const targetChip =
    outbox !== undefined && outbox.state !== "reconnecting" ? <TargetChip outbox={outbox} /> : null;
  const actions = useComposerActions({
    inline,
    oneLine,
    draftKey,
    running,
    written,
    canSend,
    asksForProject,
    touch,
    sendKey,
    blockedAccess: start.blockedAccess,
    queueing,
    onSend: () => send(),
    onStop,
    children: (
      <>
        {inline ? targetChip : null}
        {!oneLine || modelsOpen
          ? target.kind === "new"
            ? startModelChip({ target, start, open: modelsOpen, onOpenChange: setModelsOpen })
            : leadModelChip({
                lead,
                models: start.models,
                open: modelsOpen,
                onOpenChange: setModelsOpen,
                running,
              })
          : null}
        {target.kind === "new" &&
        target.mode === "work" &&
        (!inline || (rests && start.access !== "auto")) ? (
          <AccessMenu value={start.access} onPick={start.setAccess} limit={start.limit} />
        ) : null}
        {dictates ? <DictationControl dictation={dictation} /> : null}
      </>
    ),
  });

  const placeholder = listening
    ? "Listening…"
    : outbox
      ? outbox.machine
        ? `Queue a message for ${outbox.machine}`
        : "Queue a message"
      : running
        ? "Queue a follow-up"
        : resumes
          ? thread?.ended === "failed"
            ? "Send a message to try again"
            : "Send a message to pick this thread back up"
          : target.kind === "new"
            ? starting.length > 1
              ? `Message ${starting.length} models at once`
              : target.mode === "chat"
                ? "Ask anything"
                : "Describe the task"
            : `Message ${threadShown?.label}`;

  const openModels = () => {
    if (!isNew && !lead.threadPicker) return false;
    input.current?.focus({ preventScroll: true });
    setModelsOpen(true);
    return true;
  };
  useImperativeHandle(commands, () => ({ openModels, steerNow }));
  const newPlace =
    target.kind === "new" && target.mode === "work" ? (
      <ComposerProjectControls
        target={target}
        start={start}
        draft={draft}
        projectsOpen={projectsOpen}
        setProjectsOpen={setProjectsOpen}
        asksForProject={asksForProject}
        input={input}
        unfolded={unfolded}
      />
    ) : null;

  // The one line is as tall as its buttons with their margins, and its text sits centred on them:
  // the buttons grow on a touch or narrow screen, and the text with them, so the editor follows.
  const lineRow = oneLine
    ? "[--line-row:2.5rem] [--line-pad:calc((var(--line-row)-1lh)/2)]"
    : "[--line-row:2.5rem] [--line-pad:calc((var(--line-row)-1lh)/2)] pointer-coarse:[--line-row:3rem] max-md:[--line-row:3rem]";
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
        {side && thread?.onAskSide ? (
          <SideQuestion
            key={side.id}
            open={side.open}
            anchor={box}
            initial={side.initial}
            quote={side.quote}
            ask={thread.onAskSide}
            onClose={() =>
              setSide((current) =>
                current?.id === side.id ? { id: side.id, draftKey, open: false } : current,
              )
            }
            finalFocus={input}
          />
        ) : null}
        {menus.mentionMenu}
        {menus.slashMenu}
        {/* A film a step above the conversation's own: the box stands apart by that, its lit edge, the
            blur of what scrolls under it and the shadow it casts below, never as a dark slab over the glass. */}
        <div
          ref={glass}
          className={`pointer-events-auto relative border bg-surface-film shadow-film backdrop-blur-2xl transition-colors ${
            dragging ? "border-accent" : "border-line-strong"
          } ${inline ? `flex flex-wrap content-start items-end rounded-[24px] p-1 ${lineRow}` : "rounded-[18px]"} ${
            morphing
              ? "[&_:is(.reveal,.pop)]:transition-none! [&_:is(.reveal,.pop)[data-phase=leaving]]:hidden"
              : ""
          }`}
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
          {/* The glass carries the trays during a morph. On a settled box they fold as usual.
              min-w-0 keeps a tray's truncated lines inside the one-line box. */}
          {computer ? <div className={inline ? "min-w-0 basis-full" : ""}>{computer}</div> : null}
          {background ? (
            <div className={inline ? "min-w-0 basis-full" : ""}>
              <BackgroundTray background={background} />
            </div>
          ) : null}
          <QueueTray
            queue={queue}
            className={inline ? "min-w-0 basis-full" : ""}
            onEdit={(message) =>
              appendToDraft({
                segments: segmentsOf(message.text, message.mentions),
                attachments: message.attachments,
              })
            }
          />
          {menus.parameters}
          <Reveal carry className={inline ? "min-w-0 basis-full" : ""}>
            {comments.length > 0 ? (
              <CommentTray comments={comments} onEdit={editComment} onRemove={removeComment} />
            ) : null}
          </Reveal>
          <Reveal carry className={inline ? "min-w-0 basis-full" : ""}>
            {draft.attachments.length > 0 ? (
              <AttachmentTray attachments={draft.attachments} onRemove={removeAttachment} />
            ) : null}
          </Reveal>
          {inline ? attachButton : null}
          {/* On a phone, where the thread will run heads the box on a row of its own: beside the
              paperclip and the model it was squeezed to a few letters and pushed the paperclip onto a
              row alone. The row under the message is then only how it's written and sent. */}
          {!inline && narrow && newPlace ? <div className="flex min-w-0 px-2 pt-2">{newPlace}</div> : null}
          <PromptEditor
            inline={inline}
            ref={input}
            handle={editor}
            resetKey={`${draftKey}:${epoch}`}
            segments={draft.segments}
            placeholder={placeholder}
            onChange={(segments) => {
              setRecall(undefined);
              menus.clearParameters();
              updateDraft(draftKey, (current) => ({ ...current, segments }));
            }}
            onTrigger={menus.setTrigger}
            onKeyDown={onKeyDown}
            onFiles={addFiles}
            activeOption={menus.activeOption}
            // While the lead works and nothing is written, the line says what it's doing.
            cover={compact && running ? activity : undefined}
            suggestion={suggestion}
            onAcceptSuggestion={acceptSuggestion}
            onEdit={followup.dismiss}
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
                {targetChip}
                {narrow ? null : newPlace}
              </div>
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The machine a queued message goes to, in the box's action row; it opens the connection's details. */
function TargetChip({ outbox }: { readonly outbox: ComposerOutbox }) {
  const { machine, state, onOpenConnection } = outbox;
  return (
    <Button
      aria-label={machine ? `${machine}, connection details` : "Connection details"}
      onClick={onOpenConnection}
      disabled={onOpenConnection === undefined}
      className="relative flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full bg-surface-hover px-2 text-[13px] text-fg-secondary transition-colors hover:text-fg-primary pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-1.5"
    >
      <Monitor size={12} strokeWidth={1.75} className="shrink-0" />
      {machine ? <span className="max-w-[40vw] min-w-0 truncate">{machine}</span> : null}
      <span aria-hidden className="grid size-3 shrink-0 place-items-center">
        {state === "cloud" ? (
          <Cloud size={11} strokeWidth={1.75} className="text-fg-tertiary" />
        ) : (
          <span className="size-1.5 rounded-full ring-1 ring-fg-disabled" />
        )}
      </span>
    </Button>
  );
}
