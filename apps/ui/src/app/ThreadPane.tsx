import {
  ADVISOR_ROLE,
  type AgentEvent,
  type AgentId,
  type ProviderId,
  type RestorePreview,
} from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { cloudEventsAtom, queueEventsAtom, summaryEventsAtom, threadEventsAtom } from "../backend/atoms.ts";
import { leadOf, modelLabel, toAgentSummaries } from "../backend/view.ts";
import { KeptViews, useKeptHidden, useKeptResult } from "../components/KeptViews.tsx";
import { Reveal } from "../components/Reveal.tsx";
import type { AgentActions } from "../features/agents/AgentMenu.tsx";
import {
  ApprovalTray,
  type AnswerApproval,
  type AnswerQuestion,
  type AnswerSpawn,
} from "../features/agents/ApprovalTray.tsx";
import { Composer, type OutgoingMessage, type ThreadSetup } from "../features/composer/Composer.tsx";
import type { AskSide } from "../features/composer/SideQuestion.tsx";
import { draftStartAtom } from "../features/composer/drafts.ts";
import { useMessageBoxHandle, type MessageBox } from "../features/composer/messageBox.ts";
import type { PaletteCommand } from "../features/palette/palette.ts";
import type { HandoffChoice, ModelSwitch } from "../features/composer/models.ts";
import { useModels } from "../features/composer/models.ts";
import type { TurnFileOpen } from "../features/transcript/TurnChanges.tsx";
import type { TurnFileTab } from "../features/viewer/model.ts";
import { CrashGuard } from "../features/crash/CrashGuard.tsx";
import { PaneCrash } from "../features/crash/CrashViews.tsx";
import { PreviewDock } from "../features/preview/PreviewDock.tsx";
import { SetupGuessNotice } from "../features/terminal/SetupGuessNotice.tsx";
import { ConnectingNote } from "../features/threads/CloudThread.tsx";
import { ActivityLine } from "../features/composer/ActivityLine.tsx";
import { liveActivity } from "../features/composer/activity.ts";
import type { Queue } from "../features/composer/QueueTray.tsx";
import { buildTranscript, holdsQueue, queuedMessages } from "../features/transcript/model.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { EmptyThread } from "./EmptyThread.tsx";
import type { AppMode } from "./mode.ts";

type EventsAtom = Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<AgentEvent>, unknown>>;

const noEvents = Atom.make(AsyncResult.success<Array<AgentEvent>>([]));

/**
 * How many threads opened before the one a pane shows it keeps drawn, out of sight, to show again at
 * once: enough for the threads Ctrl and a digit open.
 */
const KEPT_THREADS = 2;

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
  /**
   * Takes back one of the user's messages waiting for a lead, resolving false when the agent took it
   * first; absent when the machine's backend can't.
   */
  readonly withdraw?: ((agentId: AgentId, messageId: string) => Promise<boolean>) | undefined;
  readonly switchLead: (agentId: AgentId, choice: ModelSwitch) => Promise<unknown>;
  /** Asks a lead's harness to compact its conversation. */
  readonly compact: (agentId: AgentId) => Promise<unknown>;
  /**
   * Answers a question about a thread from its lead's conversation, keeping nothing; absent when the
   * machine's backend can't.
   */
  readonly askSide?: ((agentId: AgentId, ...rest: Parameters<AskSide>) => ReturnType<AskSide>) | undefined;
  /** Hands a lead to a model of another harness; absent when the machine's backend can't. */
  readonly handOff?: ((agentId: AgentId, choice: HandoffChoice) => Promise<unknown>) | undefined;
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
  /** The machine takes the user's word on a guessed setup from the thread, so the thread asks for it. */
  readonly confirmsSetup: boolean;
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
  /** The thread's browser, docked beside it. */
  readonly preview?: ReactNode;
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
  /** The command palette's actions the message box's `/` list offers. */
  readonly slashCommands: ReadonlyArray<PaletteCommand>;
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
  preview,
  focused,
  onHandles,
  paneKey,
  actions,
  slashCommands,
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
  /** Where a new thread's question seats the message box under it, in the window. */
  const [seat, setSeat] = useState<number>();

  const viewed = selected ?? cloud?.overview;
  const cloudEvents = cloud ? cloudEventsAtom(`${cloud.machine}:${cloud.overview.thread.id}`) : noEvents;
  // Every event, streamed text included, for the conversation alone; the pane around it, with its
  // message box and approvals, reads only those its agents' summaries come from.
  const eventsAtom: EventsAtom = selected ? threadEventsAtom(selected.thread.id) : cloudEvents;
  const summaryAtom: EventsAtom = selected ? summaryEventsAtom(selected.thread.id) : cloudEvents;
  const queueAtom: EventsAtom = selected ? queueEventsAtom(selected.thread.id) : cloudEvents;
  const events = AsyncResult.getOrElse(useAtomValue(summaryAtom), (): ReadonlyArray<AgentEvent> => []);
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
  const { attempt, restore, turnFiles, handOff, askSide } = actions;
  /** Whether two of the lead's model ids name the same model. */
  const sameModel = (a: string, b: string) =>
    a === b ||
    (lead !== undefined && modelLabel(models, lead.provider, a) === modelLabel(models, lead.provider, b));
  const queueEvents = AsyncResult.getOrElse(useAtomValue(queueAtom), (): ReadonlyArray<AgentEvent> => []);
  const queued = queuedMessages(lead ? queueEvents.filter((event) => event.agentId === lead.id) : []);
  const leadActivity = leadRunning ? "running" : leadEnded ? "ended" : "idle";
  // Messages waiting behind a running turn, or for an ended lead, wait in the message box, where they
  // can be taken back. A thread read from the cloud copy can't touch them: that takes its machine.
  const { withdraw, steer } = actions;
  const queue: Queue | undefined =
    lead && holdsQueue(queued, leadActivity)
      ? {
          messages: queued.messages,
          ended: leadActivity === "ended",
          ...(cloud || !steer ? {} : { onSteer: () => void attempt(steer(lead.id)) }),
          ...(cloud || !withdraw
            ? {}
            : {
                onWithdraw: async (messageId: string) => {
                  const taken = withdraw(lead.id, messageId);
                  return (await attempt(taken)) && (await taken);
                },
              }),
        }
      : undefined;

  return (
    // The browser docks beside the conversation and its terminal drawer, which docks under the
    // conversation and keeps its message box floating above it.
    <PreviewDock preview={preview}>
      <div data-drawer-column="" className="relative flex h-full flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          {notices}
          <div className="relative min-h-0 flex-1">
            <KeptViews shown={viewed && lead ? viewed.thread.id : undefined} limit={KEPT_THREADS}>
              {viewed && lead ? (
                // A conversation that can't be drawn leaves the thread's message box to write in.
                <CrashGuard fallback={PaneCrash}>
                  <LeadTranscript
                    events={eventsAtom}
                    lead={lead.id}
                    sameModel={sameModel}
                    folder={viewed.thread.cwd}
                    threadId={viewed.thread.id}
                    focused={focused}
                    agent={{ provider: lead.provider, model: leadModel }}
                    modelName={(model, provider) => modelLabel(models, provider, model)}
                    {...(cloud ? {} : { messageBox: box })}
                    activity={leadActivity}
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
                      cloud
                        ? Promise.resolve(false)
                        : attempt(actions.respond(lead.id, requestId, decision, scope))
                    }
                    onAnswerQuestion={(requestId, response) =>
                      cloud ? Promise.resolve(false) : actions.answerQuestion(lead.id, requestId, response)
                    }
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
                </CrashGuard>
              ) : null}
            </KeptViews>
            {viewed && lead ? null : loading ? null : (
              <EmptyThread
                mode={mode}
                draftKey={draftKey}
                {...(actions.onSetUp ? { onSetUp: actions.onSetUp } : {})}
                onSeat={setSeat}
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
              seat={seat}
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
                      autoEffort: lead.autoEffort,
                      speed: lead.speed,
                      folder: viewed.thread.cwd,
                      worktree: viewed.thread.worktree,
                      ...(leadEnded ? { ended: leadEnded } : {}),
                      // A thread read from the cloud copy can't be switched: it takes its machine.
                      ...(cloud
                        ? {}
                        : { onSwitch: (choice) => attempt(actions.switchLead(lead.id, choice)) }),
                      context: agents.find((agent) => agent.id === lead.id)?.context,
                      ...(cloud ? {} : { onCompact: () => void attempt(actions.compact(lead.id)) }),
                      ...(cloud || askSide === undefined
                        ? {}
                        : { onAskSide: (question, earlier) => askSide(lead.id, question, earlier) }),
                      ...(cloud || handOff === undefined
                        ? {}
                        : {
                            handoff: {
                              available,
                              agents: agents.filter(
                                (agent) =>
                                  agent.parentId === lead.id &&
                                  agent.role !== ADVISOR_ROLE &&
                                  (agent.state === "running" ||
                                    agent.state === "queued" ||
                                    agent.state === "idle"),
                              ).length,
                              onHandOff: (choice) => attempt(handOff(lead.id, choice)),
                            },
                          }),
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
              activity={
                leadRunning && lead ? (
                  <LeadActivity events={eventsAtom} lead={lead.id} sameModel={sameModel} />
                ) : undefined
              }
              queue={queue}
              above={
                cloud ? (
                  <ConnectingNote machine={cloud.name} />
                ) : (
                  <>
                    <ApprovalTray
                      agents={agents}
                      onAnswer={actions.answerApproval}
                      onAnswerSpawn={actions.answerSpawn}
                      onAnswerQuestion={actions.answerQuestion}
                    />
                    {viewed && actions.confirmsSetup ? (
                      <SetupGuessNotice thread={viewed.thread} attempt={actions.attempt} />
                    ) : null}
                  </>
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
              slashCommands={slashCommands}
            />
          )}
        </div>
        {/* Rises from the pane's foot as it opens, and drops back into it. */}
        <Reveal shift={0} className="shrink-0">
          {drawer}
        </Reveal>
      </div>
    </PreviewDock>
  );
}

/**
 * The lead's conversation from the thread's events, which renders again for every batch of them that
 * streams in. Only it does: rendering the pane around it as well redrew its message box, approvals
 * and every card that reads the transcript's actions, even for words a subagent streamed. Kept out
 * of sight, it holds what it showed.
 */
function LeadTranscript({
  events: eventsAtom,
  lead,
  sameModel,
  focused,
  ...props
}: Omit<ComponentProps<typeof Transcript>, "blocks" | "queued"> & {
  readonly events: EventsAtom;
  readonly lead: AgentId;
  /** Whether two of the lead's model ids name the same model. */
  readonly sameModel: (a: string, b: string) => boolean;
}) {
  const hidden = useKeptHidden();
  const events = AsyncResult.getOrElse(useKeptResult(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  const leadEvents = events.filter((event) => event.agentId === lead);
  return (
    <Transcript
      {...props}
      focused={focused === true && !hidden}
      blocks={buildTranscript(leadEvents, sameModel)}
      queued={queuedMessages(leadEvents)}
    />
  );
}

/**
 * The step the lead's running turn is on, in the message box. It reads every event, as the
 * conversation does, so only it renders again as the turn's words and tool calls stream in.
 */
function LeadActivity({
  events: eventsAtom,
  lead,
  sameModel,
}: {
  readonly events: EventsAtom;
  readonly lead: AgentId;
  readonly sameModel: (a: string, b: string) => boolean;
}) {
  const events = AsyncResult.getOrElse(useAtomValue(eventsAtom), (): ReadonlyArray<AgentEvent> => []);
  const leadEvents = events.filter((event) => event.agentId === lead);
  // The step lies in the running turn: folding only that keeps each batch cheap in a long thread.
  const turn = leadEvents.slice(
    Math.max(
      0,
      leadEvents.findLastIndex((event) => event.payload._tag === "TurnInput"),
    ),
  );
  const activity = liveActivity(buildTranscript(turn, sameModel), turn);
  return activity ? <ActivityLine activity={activity} /> : null;
}
