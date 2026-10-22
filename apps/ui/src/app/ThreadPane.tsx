import type { AgentEvent, AgentId, ProviderId, RestorePreview } from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from "react";

import { cloudEventsAtom, threadEventsAtom } from "../backend/atoms.ts";
import { leadOf, modelLabel, toAgentSummaries } from "../backend/view.ts";
import type { AgentActions } from "../features/agents/AgentMenu.tsx";
import {
  ApprovalTray,
  type AnswerApproval,
  type AnswerQuestion,
  type AnswerSpawn,
} from "../features/agents/ApprovalTray.tsx";
import { Composer, type OutgoingMessage, type ThreadSetup } from "../features/composer/Composer.tsx";
import { draftStartAtom } from "../features/composer/drafts.ts";
import { useMessageBoxHandle, type MessageBox } from "../features/composer/messageBox.ts";
import type { ModelSwitch } from "../features/composer/models.ts";
import { useModels } from "../features/composer/models.ts";
import type { TurnFileOpen } from "../features/transcript/TurnChanges.tsx";
import type { TurnFileTab } from "../features/viewer/model.ts";
import { ConnectingNote } from "../features/threads/CloudThread.tsx";
import { buildTranscript, queuedMessages } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { EmptyThread } from "./EmptyThread.tsx";
import type { AppMode } from "./ModeSwitch.tsx";

const noEvents = Atom.make(AsyncResult.success<Array<AgentEvent>>([]));

/** What the window does for any of its thread panes. */
export interface ThreadPaneActions {
  /** Runs a backend action, reporting a failure; resolves whether it worked. */
  readonly attempt: (action: Promise<unknown>) => Promise<boolean>;
  readonly send: (agentId: AgentId, message: OutgoingMessage) => Promise<unknown>;
  /**
   * Sends a new version of one of the user's earlier messages to a lead; absent when the machine's
   * backend can't.
   */
  readonly edit?:
    | ((agentId: AgentId, messageId: string, message: OutgoingMessage) => Promise<unknown>)
    | undefined;
  /**
   * Reads what restoring a lead's thread to before one of the user's messages would undo, and does
   * it; absent when the machine's backend can't.
   */
  readonly restore?:
    | {
        readonly preview: (agentId: AgentId, messageId: string) => Promise<RestorePreview>;
        readonly restore: (agentId: AgentId, messageId: string) => Promise<unknown>;
      }
    | undefined;
  /**
   * Opens a file as one of an agent's turns changed it, and puts a turn's files back or forward again;
   * absent when the machine's backend can't.
   */
  readonly turnFiles?:
    | {
        readonly open: (tab: TurnFileTab) => void;
        readonly revert: (
          agentId: AgentId,
          turnId: string,
          direction: "undone" | "redone",
        ) => Promise<unknown>;
      }
    | undefined;
  /**
   * Starts a thread from the draft `draft`, in `folder`, with `message`: one with each setup, laid
   * side by side, the first in the draft's place.
   */
  readonly start: (
    draft: string,
    message: OutgoingMessage,
    setups: readonly [ThreadSetup, ...Array<ThreadSetup>],
    folder: string | undefined,
  ) => Promise<unknown>;
  readonly interrupt: (agentId: AgentId) => Promise<unknown>;
  /**
   * Hands a lead the user's messages waiting behind its turn now; absent when the machine's backend
   * can't.
   */
  readonly steer?: ((agentId: AgentId) => Promise<unknown>) | undefined;
  readonly switchLead: (agentId: AgentId, choice: ModelSwitch) => Promise<unknown>;
  readonly respond: (
    agentId: AgentId,
    requestId: string,
    decision: "allow" | "deny",
    scope: "once" | "session",
  ) => Promise<unknown>;
  readonly answerApproval: AnswerApproval;
  readonly answerSpawn: AnswerSpawn;
  readonly answerQuestion: AnswerQuestion;
  readonly agentActions: AgentActions;
  /** The user wrote to the thread: its tab is no longer only a preview. */
  readonly keep: (threadId: string) => void;
  /** Where a new thread is set up when no harness can run one. */
  readonly onSetUp: (() => void) | undefined;
  /** The new-thread folder the user picked. */
  readonly chooseFolder: (folder: string) => void;
}

export interface ThreadPaneProps {
  readonly mode: AppMode;
  /** The thread, live from the machine the window drives. */
  readonly selected: ThreadOverview | undefined;
  /** Another machine's thread, read from the cloud copy while that machine can't be reached. */
  readonly cloud:
    | { readonly machine: string; readonly name: string; readonly overview: ThreadOverview }
    | undefined;
  /** The thread isn't listed yet because the list hasn't loaded: it holds its place. */
  readonly loading: boolean;
  /** The draft the message box writes when there is no thread yet. */
  readonly draftKey: string;
  /** The folder a new thread starts in, unless its draft chose one. */
  readonly folder: string | undefined;
  /** The providers ready to run a new thread. */
  readonly available: ReadonlySet<ProviderId>;
  /** The machine can give a new thread a worktree of its own. */
  readonly worktrees: boolean;
  /** Shown in place of the message box (the thread can't take messages here). */
  readonly bar?: ReactNode;
  /** Notices over the conversation. */
  readonly notices?: ReactNode;
  /** The thread's terminal drawer, docked under it. */
  readonly drawer?: ReactNode;
  /** The pane has focus: opening a thread in it puts the cursor in its message box. */
  readonly focused: boolean;
  /**
   * Hands the window this pane's message box, by the thread it shows, so the rest of the window (the
   * files panel, shortcuts) reaches the open thread's box; none once the pane shows it no more.
   */
  readonly onHandles: (key: string, handles: PaneHandles | undefined) => void;
  /** The thread, or the thread not started yet, the pane shows. */
  readonly paneKey: string;
  readonly actions: ThreadPaneActions;
}

/** A pane's message box, as the rest of the window reaches it. */
export interface PaneHandles {
  readonly input: RefObject<HTMLDivElement | null>;
  readonly box: MessageBox;
}

/** A thread's conversation and its message box, or a new thread's empty page and box. */
export function ThreadPane({
  mode,
  selected,
  cloud,
  loading,
  draftKey,
  folder,
  available,
  worktrees,
  bar,
  notices,
  drawer,
  focused,
  onHandles,
  paneKey,
  actions,
}: ThreadPaneProps) {
  const models = useModels();
  const input = useRef<HTMLDivElement>(null);
  const [boxRef, box] = useMessageBoxHandle();
  const handOver = useEffectEvent(() => onHandles(paneKey, { input, box }));
  useEffect(() => {
    handOver();
    return () => onHandles(paneKey, undefined);
  }, [paneKey, onHandles]);
  /** How tall the message box floating over the transcript is, with what sits above it, so the transcript's end stays visible. */
  const [composerHeight, setComposerHeight] = useState(0);

  const viewed = selected ?? cloud?.overview;
  const eventsAtom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>> = selected
    ? threadEventsAtom(selected.thread.id)
    : cloud
      ? cloudEventsAtom(`${cloud.machine}:${cloud.overview.thread.id}`)
      : noEvents;
  const events = AsyncResult.getOrElse(useAtomValue(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  const draftStart = useAtomValue(draftStartAtom(draftKey));
  const newFolder = draftStart?.folder ?? folder;

  const lead = viewed ? leadOf(viewed.agents) : undefined;
  const agents = viewed ? toAgentSummaries(viewed.agents, events, models) : [];
  const leadModel =
    agents.find((agent) => agent.id === lead?.id)?.model ??
    (lead ? modelLabel(models, lead.provider, lead.model) : "");
  const leadRunning = lead?.state === "running" || lead?.state === "queued";
  // An ended lead picks the thread back up on the user's next message.
  const leadEnded = lead?.state === "stopped" || lead?.state === "failed" ? lead.state : undefined;
  const leadEvents = lead ? events.filter((event) => event.agentId === lead.id) : [];
  const { attempt, restore, turnFiles } = actions;

  return (
    // The terminal drawer docks under the conversation, which keeps its message box floating above it.
    <div className="relative flex h-full flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        {notices}
        <div className="relative min-h-0 flex-1">
          {viewed && lead ? (
            <Transcript
              key={viewed.thread.id}
              folder={viewed.thread.cwd}
              blocks={buildTranscript(
                leadEvents,
                (a, b) =>
                  a === b || modelLabel(models, lead.provider, a) === modelLabel(models, lead.provider, b),
              )}
              queued={queuedMessages(leadEvents)}
              agent={{ provider: lead.provider, model: leadModel }}
              modelName={(model) => modelLabel(models, lead.provider, model)}
              {...(cloud ? {} : { messageBox: box })}
              activity={leadRunning ? "running" : leadEnded ? "ended" : "idle"}
              bottomInset={composerHeight}
              childState={(childId) => {
                const child = agents.find((agent) => agent.id === childId);
                return child?.awaitingApproval
                  ? "needsYou"
                  : child?.state === "running" || child?.state === "queued"
                    ? "running"
                    : child?.state === "failed"
                      ? "failed"
                      : "idle";
              }}
              childAgent={(childId) => agents.find((agent) => agent.id === childId)}
              // A thread read from the cloud copy offers no agent actions: they take its machine.
              agentActions={cloud ? {} : actions.agentActions}
              onAnswerPermission={(requestId, decision, scope) =>
                cloud ? Promise.resolve(false) : attempt(actions.respond(lead.id, requestId, decision, scope))
              }
              onAnswerQuestion={(requestId, response) =>
                cloud ? Promise.resolve(false) : actions.answerQuestion(lead.id, requestId, response)
              }
              {...(cloud || !actions.steer
                ? {}
                : { onSteer: () => void attempt(actions.steer?.(lead.id) ?? Promise.resolve()) })}
              // A thread read from the cloud copy can't go back: that takes its machine.
              {...(cloud || !actions.edit
                ? {}
                : {
                    onEditMessage: (messageId: string, message: OutgoingMessage) => {
                      actions.keep(viewed.thread.id);
                      return attempt(actions.edit?.(lead.id, messageId, message) ?? Promise.resolve());
                    },
                  })}
              {...(cloud || !restore
                ? {}
                : {
                    onPreviewRestore: (messageId: string) => restore.preview(lead.id, messageId),
                    onRestoreMessage: (messageId: string) => {
                      actions.keep(viewed.thread.id);
                      return attempt(restore.restore(lead.id, messageId));
                    },
                  })}
              {...(cloud || !turnFiles || viewed.thread.cwd === undefined
                ? {}
                : {
                    turnFiles: {
                      open: (file: TurnFileOpen) =>
                        turnFiles.open({ root: viewed.thread.cwd ?? "", ...file }),
                      revert: (turnId: string, direction: "undone" | "redone") =>
                        attempt(turnFiles.revert(lead.id, turnId, direction)),
                    },
                  })}
            />
          ) : loading ? null : (
            <EmptyThread
              mode={mode}
              draftKey={draftKey}
              {...(actions.onSetUp ? { onSetUp: actions.onSetUp } : {})}
            />
          )}
        </div>

        {bar ?? (
          // While the open thread's machine is still connecting, the box keeps its draft and takes
          // writing; sending waits until the machine answers.
          <Composer
            draftKey={viewed && lead ? viewed.thread.id : draftKey}
            connecting={cloud !== undefined}
            inputRef={input}
            messageBox={boxRef}
            // Panes opening side by side leave the cursor where the user put it: only the focused one takes it.
            takesFocus={focused}
            target={
              viewed && lead
                ? {
                    kind: "thread",
                    provider: lead.provider,
                    model: leadModel,
                    modelId: lead.model,
                    effort: lead.effort,
                    folder: viewed.thread.cwd,
                    worktree: viewed.thread.worktree,
                    ...(leadEnded ? { ended: leadEnded } : {}),
                    // A thread read from the cloud copy can't be switched: it takes its machine.
                    ...(cloud ? {} : { onSwitch: (choice) => attempt(actions.switchLead(lead.id, choice)) }),
                  }
                : {
                    kind: "new",
                    mode,
                    folder: newFolder,
                    onChooseFolder: actions.chooseFolder,
                    available,
                    worktrees,
                  }
            }
            running={leadRunning && cloud === undefined}
            above={
              cloud ? (
                <ConnectingNote machine={cloud.name} />
              ) : (
                <ApprovalTray
                  agents={agents}
                  onAnswer={actions.answerApproval}
                  onAnswerSpawn={actions.answerSpawn}
                  onAnswerQuestion={actions.answerQuestion}
                />
              )
            }
            onHeight={setComposerHeight}
            onSend={(message, setups) => {
              // Writing to a thread keeps its tab: it's no longer only a preview.
              if (viewed) actions.keep(viewed.thread.id);
              return attempt(
                selected && lead
                  ? actions.send(lead.id, message)
                  : actions.start(draftKey, message, setups, newFolder),
              );
            }}
            onStop={() => {
              if (lead) void attempt(actions.interrupt(lead.id));
            }}
          />
        )}
      </div>
      {drawer}
    </div>
  );
}
