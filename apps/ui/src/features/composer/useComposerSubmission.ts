import { type ModelInfo } from "@cerium/protocol";
import { useAtomSet } from "@effect/atom-react";
import { type RefObject } from "react";

import { holdRenderer } from "../../desktop/hibernation.ts";
import { launch } from "./flight.ts";
import { draftMentions, draftText, hasContent, withComments, type Draft } from "./draft.ts";
import { draftsAtom, revokeLostPreviews, withoutDraft } from "./drafts.ts";
import type { MessageBox } from "./messageBox.ts";
import { effortFor, speedFor } from "./models.ts";
import { sideQuestionOf } from "./btw.ts";
import { type Queue } from "./QueueTray.tsx";

import type { ComposerTarget, OutgoingMessage, ThreadSetup } from "./composerTypes.ts";
import type { StartChoices } from "./useStartChoices.ts";

export function useComposerSubmission({
  target,
  draft,
  draftKey,
  connecting,
  filling,
  start,
  input,
  running,
  queue,
  onSend,
  onSteer,
  openSide,
  onChooseProject,
  onClear,
  onRestore,
}: {
  readonly target: ComposerTarget;
  readonly draft: Draft;
  readonly draftKey: string;
  readonly connecting: boolean;
  readonly filling: boolean;
  readonly start: Pick<
    StartChoices,
    | "isNew"
    | "starting"
    | "blockedAccess"
    | "activeEffort"
    | "activeSpeed"
    | "autoEffort"
    | "access"
    | "worktree"
  >;
  readonly input: RefObject<HTMLDivElement | null>;
  readonly running: boolean;
  readonly queue: Queue | undefined;
  readonly onSend: (
    message: OutgoingMessage,
    setups: readonly [ThreadSetup, ...Array<ThreadSetup>],
    taskId: string | undefined,
  ) => Promise<boolean>;
  readonly onSteer: (() => void) | undefined;
  readonly openSide: MessageBox["openSide"];
  readonly onChooseProject: () => void;
  readonly onClear: () => void;
  readonly onRestore: () => void;
}) {
  const { isNew, starting, blockedAccess, activeEffort, activeSpeed, autoEffort, access, worktree } = start;
  const setDrafts = useAtomSet(draftsAtom);
  const thread = target.kind === "thread" ? target : undefined;
  const needsFolder = target.kind === "new" && target.mode === "work" && target.folder === undefined;
  const text = draftText(draft.segments);
  const preparing = draft.attachments.some((attachment) => attachment.state._tag === "Preparing");
  const comments = draft.comments ?? [];
  const ready = [
    ...draft.attachments.flatMap((attachment) =>
      attachment.state._tag === "Ready" ? [attachment.state.attachment] : [],
    ),
    ...comments.flatMap((comment) => (comment.element ? [comment.element.screenshot] : [])),
  ];
  const written = text.trim() !== "" || ready.length > 0 || comments.length > 0;
  // As the editor counts it: only line breaks left, no files, no comments.
  const blankBox =
    draft.segments.every((segment) => segment.kind === "text" && segment.text.replace(/\n/g, "") === "") &&
    draft.attachments.length === 0 &&
    comments.length === 0;
  const sendable =
    written && !preparing && !connecting && !blockedAccess && !filling && (!isNew || starting.length > 0);
  const canSend = sendable && !needsFolder;
  /** A finished message waits only for a project: sending opens the project list rather than doing nothing. */
  const asksForProject = sendable && needsFolder;
  const send = (afterDelivery?: () => void) => {
    if (filling) return;
    const asked = thread?.onAskSide ? sideQuestionOf(text) : undefined;
    if (asked !== undefined) {
      // A side question never joins the thread: the box empties and the pop-over answers.
      revokeLostPreviews({ [draftKey]: draft }, {});
      setDrafts((current) => withoutDraft(current, draftKey));
      onClear();
      openSide({ initial: asked });
      return;
    }
    if (asksForProject) {
      onChooseProject();
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
        access,
        ...(worktree ? { worktree } : {}),
        ...(draft.start?.workspace
          ? { workspace: draft.start.workspace }
          : worktree
            ? { workspace: {} }
            : {}),
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
    onClear();
    const release = holdRenderer();
    void onSend(
      { text: message, attachments: ready, mentions: draftMentions(draft.segments) },
      [setupOf(first), ...rest.map(setupOf)],
      sent.start?.taskId,
    )
      .then((delivered) => {
        if (delivered) {
          for (const attachment of sent.attachments) {
            if (attachment.preview) URL.revokeObjectURL(attachment.preview);
          }
          afterDelivery?.();
          return;
        }
        // Give an undelivered message back, unless the user has started writing another.
        setDrafts((current) => (hasContent(current[key]) ? current : { ...current, [key]: sent }));
        onRestore();
      })
      .finally(release);
  };

  const steerNow = () => {
    if (!running || onSteer === undefined || filling) return false;
    if (written) {
      if (!canSend || (thread?.onAskSide && sideQuestionOf(text) !== undefined)) return false;
      // The backend accepts and queues the message before resolving the send.
      send(onSteer);
      return true;
    }
    if (blankBox && queue?.onSteer && !queue.ended && queue.messages.length > 0) {
      queue.onSteer();
      return true;
    }
    return false;
  };

  return { text, comments, written, blankBox, needsFolder, canSend, asksForProject, send, steerNow };
}
