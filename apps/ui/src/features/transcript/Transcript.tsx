import { Button } from "@base-ui/react/button";
import type {
  AgentEvent,
  AgentId,
  ProviderId,
  QuestionResponse,
  RestorePreview,
  ThreadId,
} from "@cerium/protocol";
import type { ThreadHistory } from "../../backend/threadLog.ts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDown, History } from "lucide-react";
import {
  createContext,
  memo,
  use,
  useMemo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";

import { ImageGallery } from "../../components/ImageViewer.tsx";
import { Reveal } from "../../components/Reveal.tsx";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { useKeyboardOpen } from "../../web/viewport.ts";
import type { AgentActions } from "../agents/AgentMenu.tsx";
import type { AgentSummary } from "../agents/model.ts";
import type { OutgoingMessage } from "../composer/Composer.tsx";
import { segmentsOf } from "../composer/draft.ts";
import { MessageBoxContext, useMessageBox, type MessageBox } from "../composer/messageBox.ts";
import { ClosedQuestions, QuestionCard } from "../questions/QuestionCard.tsx";
import { useReviewsOffered } from "../review/hooks.ts";
import { textScale, textSizeAtom } from "../settings/preferences.ts";
import { providerName } from "../threads/model.ts";
import {
  Compaction,
  ImportedFrom,
  LimitNote,
  ModelSwitch,
  Notice,
  PermissionCard,
  Reasoning,
  SpawnAsk,
  SpawnCard,
  TurnFooter,
  UserMessage,
  Working,
  type ChildState,
} from "./Blocks.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import { layout, runTimings, showsProgress, type Item } from "./layout.ts";
import { Markdown } from "./Markdown.tsx";
import { MessageMenuArea } from "./MessageMenu.tsx";
import {
  holdsQueue,
  type AgentActivity,
  type QueuedMessages,
  type TranscriptBlock,
  type TurnChanges as TurnChangesModel,
} from "./model.ts";
import { PromptStepper, promptsOf, type PromptSteps } from "./PromptStepper.tsx";
import { PushCard } from "./PushCard.tsx";
import { previewFailure } from "./restore.ts";
import { ForkDialog } from "./ForkDialog.tsx";
import type { ForkActions, ForkCheck } from "./fork.ts";
import { RestoreDialog, type RestoreCheck } from "./RestoreDialog.tsx";
import { SelectionReply } from "./SelectionReply.tsx";
import { TranscriptFind } from "./FindBar.tsx";
import { ToolGroup, ToolRun } from "./ToolGroup.tsx";
import { threadImages } from "./tools.ts";
import { TurnChanges, type TurnFileActions } from "./TurnChanges.tsx";
import { useStickToBottom } from "./useStickToBottom.ts";
import { WorkDisclosures, WorkSection } from "./Work.tsx";
import { useArrivals, usePresence } from "../../lib/motion.ts";
import { HistoryWindow } from "./HistoryWindow.tsx";

interface TranscriptProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly promptSteps?: Ref<PromptSteps> | undefined;
  readonly live?: ReadonlyMap<string, AgentEvent>;
  readonly history?: ThreadHistory;
  readonly searchAgent?: AgentId | undefined;
  readonly searchCloudKey?: string | undefined;
  /** The user's messages that haven't reached the agent yet. */
  readonly queued: QueuedMessages;
  /** The lead's provider, which a switch that names none ran on. */
  readonly agent: { readonly provider: ProviderId };
  /** A model's id as people know it ("Opus 5.5"); without it, switches show the id. */
  readonly modelName?: ((model: string, provider: ProviderId) => string) | undefined;
  /** The thread's folder, which paths in the conversation are relative to; absent for chats. */
  readonly folder?: string | undefined;
  /** The thread's message box, which messages and chips can put content into; absent when closed. */
  readonly messageBox?: MessageBox | undefined;
  readonly onOpenSideQuestion?: ((quote: string) => void) | undefined;
  readonly activity: AgentActivity;
  /** Live state of a spawned child, for its card. */
  readonly childState: (childId: string) => ChildState;
  /** A spawned child's live record, which its card's menu works from. */
  readonly childAgent: (childId: string) => AgentSummary | undefined;
  /** What a spawn card's click and menu do. */
  readonly agentActions: AgentActions;
  /** How tall the message box floating over the transcript's end stands, in pixels; the end stays clear of it. */
  readonly bottomInset?: number;
  readonly onAnswerPermission?: (
    requestId: string,
    decision: "allow" | "deny",
    scope: "once" | "session",
  ) => void;
  /** Answers the agent's questions; resolves to false when the answer didn't reach it. */
  readonly onAnswerQuestion?: (requestId: string, response: QuestionResponse) => Promise<boolean>;
  /**
   * Sends a new version of one of the user's earlier messages, the conversation going back to before
   * it; resolves whether it went. Without it, messages can't be edited.
   */
  readonly onEditMessage?: (messageId: string, message: OutgoingMessage) => Promise<boolean>;
  /** What restoring the thread to before one of the user's messages would undo. */
  readonly onPreviewRestore?: (messageId: string) => Promise<RestorePreview>;
  /**
   * Restores the thread to before one of the user's messages; resolves whether it did. Without it
   * (or the preview), messages offer no restore.
   */
  readonly onRestoreMessage?: (messageId: string) => Promise<boolean>;
  /** Forks the thread into a new one from one of the user's messages; without it, messages offer no fork. */
  readonly onFork?: ForkActions | undefined;
  /** Opens the files a turn changed and undoes them; without it, a turn's files are only listed. */
  readonly turnFiles?: TurnFileActions | undefined;
  /** The thread the conversation is of, which a message a palette search picked is found in. */
  readonly threadId?: string | undefined;
  readonly onAddTask?: ((text: string) => void) | undefined;
  /** The pane shows this conversation and has focus, so Ctrl F opens its find bar. */
  readonly focused?: boolean | undefined;
}

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

/**
 * What an earlier response's footer wears so it stays out of sight until its response is under the
 * pointer or has focus (touch screens, which can't hover, always show it). The latest response's
 * footer, and any that says the turn was cut short, stay in view. `:hover+&` is the item just
 * before the footer, which is the response's last part; `:hover+*+&` that part when the files the
 * turn changed sit between them.
 */
const quietFooter = (item: Extract<Item, { kind: "turnEnd" }>, latest: string | undefined) =>
  item.id === latest || item.block.stopReason !== "completed"
    ? ""
    : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 [:focus-within+&]:opacity-100 [:hover+&]:opacity-100 [:hover+*+&]:opacity-100";

/**
 * How an item comes in while the thread is open: a line writes itself out in reading order, and a
 * card or a whole message unrolls downward. A streaming message writes itself out word by word.
 */
const entrance = (item: Item): string => {
  switch (item.kind) {
    case "input":
      return "arrive";
    // A run writes in its own line, and brings in each of its steps as they come.
    case "run":
    case "work":
    case "replaced":
    case "turnEnd":
      return "";
    case "tools":
      return "unroll";
    case "spawns":
      return "arrive-spawns";
    case "switch":
    case "imported":
    case "spawnAsk":
      return "write-in";
    case "push":
      return "unroll";
    case "block":
      switch (item.block.kind) {
        case "message":
          return item.block.streaming ? "" : "unroll";
        case "permission":
        case "question":
          return "unroll asks";
        default:
          return "write-in";
      }
  }
};

const MessageArrivals = createContext<Set<string> | undefined>(undefined);

function ItemEntrance({
  item,
  arrived,
  replaced = false,
  delay,
  children,
}: {
  item: Item;
  arrived: boolean;
  replaced?: boolean;
  delay?: string | undefined;
  children: ReactNode;
}) {
  const messages = use(MessageArrivals);
  const message = item.kind === "block" && item.block.kind === "message";
  const [enter] = useState(() => (arrived && !(message && messages?.has(item.id)) ? entrance(item) : ""));
  // Keep a message's first entrance when it becomes a step under Working or remounts in history.
  useLayoutEffect(() => {
    if (message && arrived) messages?.add(item.id);
  }, [message, arrived, messages, item.id]);
  return (
    <div
      // A message sent rises out of the message box, its text flying there from where it was written.
      {...(item.kind === "input" ? { "data-from-box": "" } : {})}
      // The prompt stepper finds a prompt to bring into view by it.
      {...(item.kind === "input" && !replaced ? { "data-prompt": item.id } : {})}
      className={enter === "unroll" && delay ? "unroll step-entrance" : enter}
      style={enter ? writeDelay(delay) : undefined}
    >
      {children}
    </div>
  );
}

/** An item's id, and those of the steps inside it, which come in one by one as a run or work grows. */
const idsOf = (item: Item): ReadonlyArray<string> =>
  item.kind === "run" || item.kind === "work" ? [item.id, ...item.steps.flatMap(idsOf)] : [item.id];

/** Steps that follow their section's header in the same update. */
const openingSteps = (
  item: Item,
  together: ReturnType<typeof useArrivals>["together"],
): ReadonlyArray<string> => {
  if (item.kind !== "run" && item.kind !== "work") return [];
  const first = item.steps[0];
  return [
    ...(first && together(item.id, first.id) ? [first.id] : []),
    ...item.steps.flatMap((step) => openingSteps(step, together)),
  ];
};

/** A work's steps with its runs opened up: its calls and thoughts, each with its time. */
const workSteps = (steps: ReadonlyArray<Item>) =>
  steps.flatMap((step) => (step.kind === "run" ? step.steps : [step]));

const containsBlock = (item: Item, id: string): boolean => {
  if (item.id === id) return true;
  if (item.kind === "input") return item.blocks.some((block) => block.id === id);
  if (item.kind === "run" || item.kind === "work") return item.steps.some((step) => containsBlock(step, id));
  if (item.kind === "replaced") return item.items.some((each) => containsBlock(each, id));
  return false;
};

export function Transcript({
  blocks,
  promptSteps,
  live,
  history,
  searchAgent,
  searchCloudKey,
  queued,
  agent,
  modelName,
  folder,
  messageBox,
  onOpenSideQuestion,
  activity,
  childState,
  childAgent,
  agentActions,
  bottomInset = 0,
  onAnswerPermission,
  onAnswerQuestion,
  onEditMessage,
  onPreviewRestore,
  onRestoreMessage,
  onFork,
  turnFiles,
  threadId,
  onAddTask,
  focused = false,
}: TranscriptProps) {
  // Read from the spawns as text, which stays equal while they do, so `actions` below stays the same
  // object: every card that reads it renders again when it changes, which was every streamed batch.
  const spawned = JSON.stringify(
    blocks.flatMap((block) => (block.kind === "spawn" ? [[block.childId, block.role, block.provider]] : [])),
  );
  const { roleOf, providerOf } = useMemo(() => {
    const spawns = JSON.parse(spawned) as Array<[string, string, ProviderId]>;
    const roles = new Map(spawns.map(([id, role]) => [id, role]));
    const providers = new Map(spawns.map(([id, , provider]) => [id, provider]));
    return {
      roleOf: (agentId: string) => roles.get(agentId) ?? "An agent",
      providerOf: (agentId: string) => providers.get(agentId),
    };
  }, [spawned]);
  // Messages waiting for the agent's session read as sent, with its progress below them. Ones that
  // wait behind a running turn, or for an ended agent to start again, wait in the message box.
  // Other threads' messages for its next turn show where they came in.
  const shown = holdsQueue(queued, activity)
    ? [...blocks, ...queued.held]
    : [...blocks, ...queued.held, ...queued.messages];
  const { viewport, attachViewport, following, toEnd, unfollow, onTailMounted } = useStickToBottom(
    queued.messages.at(-1)?.id ?? blocks.findLast((block) => block.kind === "user")?.id,
  );
  const items = layout(shown);
  // What comes in while the thread is open rises into place; what it opened with stays still.
  const arrived = useArrivals(items.flatMap(idsOf));
  const last = items.at(-1);
  const latestFooter = items.findLast((item) => item.kind === "turnEnd")?.id;
  const working = activity === "running" && !showsProgress(last);
  const waitingAfter = working ? (last?.id ?? null) : undefined;
  const [turnStart, setTurnStart] = useState<{
    waitingAfter: typeof waitingAfter;
    visible?: boolean;
    handoff?: { after: string | null; header: string };
  }>({ waitingAfter });
  if (turnStart.waitingAfter !== waitingAfter) {
    const after = turnStart.waitingAfter;
    const previous = after === null ? -1 : items.findIndex((item) => item.id === after);
    const next = after === null || previous >= 0 ? items[previous + 1] : undefined;
    // Only the header taking the waiting line's place inherits its exit.
    const handoff =
      turnStart.visible &&
      !working &&
      after !== undefined &&
      (next?.kind === "run" || next?.kind === "work") &&
      arrived(next.id)
        ? { after, header: next.id }
        : undefined;
    setTurnStart({ waitingAfter, ...(handoff ? { handoff } : {}) });
  }
  const workingLine = (after: string | null) =>
    waitingAfter === after || turnStart.handoff?.after === after ? (
      <WorkingLine
        show={waitingAfter === after}
        onVisible={() =>
          setTurnStart((start) => (start.waitingAfter === after ? { ...start, visible: true } : start))
        }
      />
    ) : null;
  // A switch names the model as people know it.
  const modelLabel = (model: string, provider: ProviderId | undefined) =>
    modelName?.(model, provider ?? agent.provider) ?? model;
  // The chosen text size scales the whole column, so icons and spacing keep their proportions.
  const scale = textScale(useAtomValue(textSizeAtom));
  // A phone's keyboard shrinks the message box to one line, so the end needs less room.
  const oneLine = useKeyboardOpen();
  const column = useRef<HTMLDivElement>(null);
  const actions: TranscriptActions = {
    roleOf,
    providerOf,
    childState,
    childAgent,
    agentActions,
    ...(onAnswerPermission ? { onAnswerPermission } : {}),
    ...(onAnswerQuestion ? { onAnswerQuestion } : {}),
    ...(onEditMessage ? { onEditMessage } : {}),
    onAddTask,
    ...(onFork ? { fork: onFork } : {}),
    ...(turnFiles ? { turnFiles } : {}),
    ...(threadId === undefined ? {} : { threadId }),
    ...(onPreviewRestore && onRestoreMessage
      ? {
          restore: {
            preview: onPreviewRestore,
            restore: onRestoreMessage,
            harness: providerName[agent.provider],
          },
        }
      : {}),
  };
  // A version a rewind replaced is there to read: its messages can't be edited, and what it asked
  // the user can't be answered any more.
  const renderItem = (item: Item, replaced: boolean): ReactNode =>
    item.kind === "replaced" ? (
      <EarlierVersion key={item.id} item={item} turns={item.turns} files={item.files}>
        <HistoryWindow
          items={item.items}
          viewport={viewport}
          following={false}
          onReveal={unfollow}
          contains={containsBlock}
          render={(each) => renderItem(each, true)}
        />
      </EarlierVersion>
    ) : item.kind === "turnEnd" ? (
      <TurnEndItem
        key={item.id}
        item={item}
        animate={!replaced && arrived(item.id)}
        replaced={replaced}
        quiet={quietFooter(item, replaced ? undefined : latestFooter)}
      />
    ) : (
      <ItemEntrance key={item.id} item={item} arrived={!replaced && arrived(item.id)} replaced={replaced}>
        <TranscriptItem
          item={item}
          last={!replaced && item === last}
          activity={replaced ? "ended" : activity}
          provider={(item.kind === "switch" ? item.provider : undefined) ?? agent.provider}
          model={item.kind === "switch" ? modelLabel(item.model, item.provider) : ""}
          replaced={replaced}
          handoff={!replaced && turnStart.handoff?.header === item.id}
          opening={replaced ? "" : openingSteps(item, arrived.together).join(" ")}
          fresh={
            !replaced && (item.kind === "run" || item.kind === "work")
              ? idsOf(item).filter(arrived).join(" ")
              : ""
          }
        />
      </ItemEntrance>
    );

  return (
    <LiveText value={live ?? emptyLive}>
      <WorkDisclosures threadId={threadId}>
        <ThreadContext folder={folder} messageBox={messageBox} actions={actions}>
          {/* An image opened from the conversation steps through all of the thread's others. */}
          <ImageGallery images={() => threadImages(shown)}>
            <div
              className="transcript-motion relative h-full"
              style={{ "--composer": `${bottomInset}px` } as CSSProperties}
            >
              {/* Content fades out where the floating composer sits instead of showing through its glass. */}
              <ScrollArea
                viewportRef={attachViewport}
                // Following owns the scroll position; a reader keeps native anchors during reflows.
                viewportClassName={following ? "[overflow-anchor:none]" : ""}
                className={`h-full ${
                  oneLine
                    ? "mask-b-from-[calc(100%_-_max(4.5rem,_var(--composer)_+_1rem))] mask-b-to-[calc(100%_-_max(1rem,_var(--composer)_-_2.5rem))]"
                    : "mask-b-from-[calc(100%_-_max(9rem,_var(--composer)_+_2rem))] mask-b-to-[calc(100%_-_max(2rem,_var(--composer)_-_5rem))]"
                }`}
              >
                <div
                  ref={column}
                  className="relative mx-auto flex max-w-[50.2rem] flex-col gap-3 px-4 pt-5 md:px-8 md:pt-8"
                  // The inset is in screen pixels; the column's zoom would scale it.
                  style={{
                    zoom: scale,
                    paddingBottom: `max(${oneLine ? "5rem" : "10rem"}, calc(${bottomInset / scale}px + ${oneLine ? "1.5rem" : "3rem"}))`,
                  }}
                >
                  {workingLine(null)}
                  <HistoryWindow
                    items={items}
                    viewport={viewport}
                    history={history}
                    following={following}
                    onTailMounted={onTailMounted}
                    onReveal={unfollow}
                    contains={containsBlock}
                    render={(item) => (
                      <>
                        {renderItem(item, false)}
                        {workingLine(item.id)}
                      </>
                    )}
                  />
                </div>
              </ScrollArea>
              <PromptStepper
                prompts={promptsOf(items)}
                viewport={viewport}
                onReveal={unfollow}
                steps={focused ? promptSteps : undefined}
              />
              <SelectionReply within={column} onOpenSideQuestion={onOpenSideQuestion} />
              {/* Back to the latest output after scrolling up to read; sits just above the composer. */}
              <Button
                onClick={toEnd}
                aria-label="Jump to latest"
                inert={following}
                style={{
                  bottom: `max(${oneLine ? "4.5rem" : "7.75rem"}, calc(${bottomInset}px + ${oneLine ? "1rem" : "0.75rem"}))`,
                }}
                className={`absolute left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-line-subtle bg-surface-raised text-fg-secondary shadow-raised backdrop-blur-2xl transition-[opacity,translate] duration-200 ease-out-soft hover:text-fg-primary ${
                  following ? "pointer-events-none translate-y-1 opacity-0" : "opacity-100"
                }`}
              >
                <ArrowDown size={15} strokeWidth={2} />
              </Button>
              <TranscriptFind
                scope={column}
                viewport={viewport}
                threadId={threadId}
                agentId={searchAgent}
                cloudKey={searchCloudKey}
                focused={focused}
                blocks={shown}
                live={live}
                history={history}
              />
            </div>
          </ImageGallery>
        </ThreadContext>
      </WorkDisclosures>
    </LiveText>
  );
}

function WorkingLine({ show, onVisible }: { show: boolean; onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const phase = usePresence(show, ref);
  return phase === "gone" ? null : (
    <div ref={ref} data-phase={phase} aria-hidden={!show} className="turn-start-wait max-md:py-1">
      <div
        className="arrive-late"
        onAnimationStart={(event) => {
          if (event.target === event.currentTarget) onVisible();
        }}
      >
        <Working />
      </div>
    </div>
  );
}

/**
 * What the transcript's cards ask about agents and do for the user. The window makes these afresh
 * on every update, so they reach the few cards that use them through context rather than as props
 * of every item, which would re-render the whole conversation for each streamed word.
 */
interface TranscriptActions {
  readonly onAddTask?: TranscriptProps["onAddTask"];
  readonly roleOf: (agentId: string) => string;
  readonly providerOf: (agentId: string) => ProviderId | undefined;
  readonly childState: TranscriptProps["childState"];
  readonly childAgent: TranscriptProps["childAgent"];
  readonly agentActions: AgentActions;
  readonly onAnswerPermission?: TranscriptProps["onAnswerPermission"];
  readonly onAnswerQuestion?: TranscriptProps["onAnswerQuestion"];
  readonly onEditMessage?: TranscriptProps["onEditMessage"];
  readonly restore?: {
    readonly preview: NonNullable<TranscriptProps["onPreviewRestore"]>;
    readonly restore: NonNullable<TranscriptProps["onRestoreMessage"]>;
    /** The lead's harness by name, which the restore's preview says what becomes of. */
    readonly harness: string;
  };
  readonly fork?: ForkActions;
  readonly turnFiles?: TurnFileActions | undefined;
  /** The thread shown, whose pushes its push cards follow. */
  readonly threadId?: string | undefined;
}

const Actions = createContext<TranscriptActions>({
  roleOf: () => "An agent",
  providerOf: () => undefined,
  childState: () => "idle",
  childAgent: () => undefined,
  agentActions: {},
});

/** What the transcript's chips, messages and cards work from. */
function ThreadContext({
  folder,
  messageBox,
  actions,
  children,
}: {
  folder: string | undefined;
  messageBox: MessageBox | undefined;
  actions: TranscriptActions;
  children: ReactNode;
}) {
  const [messageArrivals] = useState(() => new Set<string>());
  return (
    <MessageArrivals value={messageArrivals}>
      <WorkspaceFolder value={folder}>
        <MessageBoxContext value={messageBox}>
          <Actions value={actions}>{children}</Actions>
        </MessageBoxContext>
      </WorkspaceFolder>
    </MessageArrivals>
  );
}

/**
 * Whether two values hold the same content, looking `depth` levels in. Blocks are rebuilt from the
 * events on every update, but what they carry (tool inputs and outputs, texts) is the events' own,
 * so comparing a few levels down finds an unchanged item cheaply.
 */
const same = (a: unknown, b: unknown, depth = 6): boolean => {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) =>
    same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth - 1),
  );
};

interface ItemProps {
  readonly item: Item;
  /** The transcript's latest item, the one a running agent is working on. */
  readonly last: boolean;
  readonly activity: AgentActivity;
  readonly provider: ProviderId;
  readonly model: string;
  /** The item belongs to a version a rewind replaced. */
  readonly replaced: boolean;
  /** The item's header takes the waiting line's place. */
  readonly handoff: boolean;
  /** The ids of steps that arrived with their headers, space-separated. */
  readonly opening: string;
  /** For a run, the ids of it and its steps that came in while the thread was open, space-separated. */
  readonly fresh: string;
}

/**
 * One item of the conversation. Only an item whose content changed renders again: while an agent
 * streams, that's the reply at the end. Re-rendering every earlier item for each streamed word made
 * a long thread's updates three times as slow (scratch transcript benchmark, 1,900 events).
 */
const TranscriptItem = memo(
  function TranscriptItem({
    item,
    last,
    activity,
    provider,
    model,
    replaced,
    fresh,
    opening,
    handoff,
  }: ItemProps) {
    const arrived = new Set(fresh.split(" "));
    const openingIds = new Set(opening.split(" "));
    const [starting] = useState(handoff);
    const renderSteps = (
      section: Extract<Item, { kind: "run" | "work" }>,
      live: boolean,
      quiet: boolean,
      headerDelay: string | undefined,
    ) => {
      // A work's only run is all its header counts, so its steps show without a second line saying so.
      const lone =
        section.kind === "work" && section.steps.filter((step) => step.kind === "run").length === 1;
      return section.steps.map((step, index) => {
        // A step that opens its section follows its header. Subsequent steps show as they arrive.
        const delay = openingIds.has(step.id) ? `calc(${headerDelay ?? "0ms"} + 80ms)` : undefined;
        return (
          <ItemEntrance key={step.id} item={step} arrived={arrived.has(step.id)} delay={delay}>
            {render(step, live && index === section.steps.length - 1, quiet, delay, lone)}
          </ItemEntrance>
        );
      });
    };
    /** `tail` is the step a running agent is on: the transcript's latest, or the last of live work. */
    const render = (each: Item, tail: boolean, quiet = false, delay?: string, lone = false): ReactNode => {
      const takesWaitingLine = starting && each.id === item.id;
      const headerClass = arrived.has(each.id) ? (takesWaitingLine ? "turn-start-header" : "write-in") : "";
      const headerDelay = takesWaitingLine ? "var(--turn-start-fade)" : delay;
      switch (each.kind) {
        case "input":
          return (
            <div key={each.id} className="flex flex-col items-end gap-2 py-3">
              {each.blocks.map((block) =>
                block.kind === "user" ? (
                  <EditableMessage key={block.id} block={block} replaced={replaced} />
                ) : null,
              )}
            </div>
          );
        case "imported":
          return <ImportedFrom key={each.id} block={each.block} />;
        case "switch":
          return (
            <ModelSwitch
              key={each.id}
              provider={provider}
              model={model}
              {...(each.effort ? { effort: each.effort } : {})}
              {...(each.speed ? { speed: each.speed } : {})}
              change={each.change}
            />
          );
        case "run":
          return (
            <ToolRun
              key={each.id}
              id={each.id}
              tools={each.steps.flatMap((step) => (step.kind === "tools" ? step.tools : []))}
              timings={runTimings(each.steps)}
              live={tail && activity === "running"}
              bare={lone}
              activity={activity}
              headerClass={headerClass}
              headerStyle={writeDelay(headerDelay)}
            >
              {renderSteps(each, false, false, headerDelay)}
            </ToolRun>
          );
        case "work": {
          const live = !each.done && activity === "running";
          const steps = workSteps(each.steps);
          return (
            <WorkSection
              key={each.id}
              tools={steps.flatMap((step) => (step.kind === "tools" ? step.tools : []))}
              timings={runTimings(steps)}
              live={live}
              headerClass={headerClass}
              headerStyle={writeDelay(headerDelay)}
              stepIds={steps.map((step) => step.id)}
              contains={(id) => containsBlock(each, id)}
            >
              {renderSteps(each, live, true, headerDelay)}
            </WorkSection>
          );
        }
        case "tools":
          return <ToolGroup key={each.id} tools={each.tools} activity={activity} />;
        case "spawns":
          return <SpawnCards key={each.id} spawns={each.spawns} />;
        case "spawnAsk":
          return <SpawnAsk key={each.id} call={each.call} />;
        case "push":
          return <PushItem key={each.id} call={each.call} />;
        case "block":
          return (
            <ResponseBlock
              key={each.id}
              block={each.block}
              activity={activity}
              quiet={quiet}
              replaced={replaced}
            />
          );
        // Laid out by the transcript itself, around the items it holds.
        case "turnEnd":
        case "replaced":
          return null;
      }
    };
    return render(item, last);
  },
  (before, after) =>
    before.last === after.last &&
    before.activity === after.activity &&
    before.provider === after.provider &&
    before.model === after.model &&
    before.replaced === after.replaced &&
    before.handoff === after.handoff &&
    before.opening === after.opening &&
    before.fresh === after.fresh &&
    // Deep enough for the calls inside a work's runs.
    same(before.item, after.item, 9),
);

const writeDelay = (delay: string | undefined): CSSProperties | undefined =>
  delay === undefined ? undefined : ({ "--write-delay": delay } as CSSProperties);

/** Keeps the files above their footer, even when the snapshot follows the turn in a later update. */
const TurnEndItem = memo(
  function TurnEndItem({
    item,
    animate,
    replaced,
    quiet,
  }: {
    item: Extract<Item, { kind: "turnEnd" }>;
    animate: boolean;
    replaced: boolean;
    quiet: string;
  }) {
    const { changes } = item.block;
    const [endedAt] = useState(() => performance.now());
    return (
      <div className="flex flex-col">
        {changes === undefined ? null : animate ? (
          <TurnFilesArrival endedAt={endedAt} changes={changes} />
        ) : (
          <div className="pb-3">
            <TurnChangesItem changes={changes} replaced={replaced} />
          </div>
        )}
        <div className={`${quiet} ${animate ? "turn-footer" : ""}`}>
          <TurnFooter block={item.block} text={item.text} routed={item.routed} />
        </div>
      </div>
    );
  },
  (before, after) =>
    before.animate === after.animate &&
    before.replaced === after.replaced &&
    before.quiet === after.quiet &&
    same(before.item, after.item, 9),
);

function TurnFilesArrival({ endedAt, changes }: { endedAt: number; changes: TurnChangesModel }) {
  // Spend only the time left before the file card's beat. A late snapshot opens on arrival.
  const [elapsed] = useState(() => performance.now() - endedAt);
  return (
    <div style={{ "--turn-elapsed": `${elapsed}ms` } as CSSProperties}>
      <Reveal shift={0} className="turn-files">
        <div className="pb-3">
          <TurnChangesItem changes={changes} replaced={false} />
        </div>
      </Reveal>
    </div>
  );
}

/** The files a turn changed; renders again when they or what became of them changes. */
const TurnChangesItem = memo(
  function TurnChangesItem({ changes, replaced }: { changes: TurnChangesModel; replaced: boolean }) {
    const { turnFiles, threadId } = use(Actions);
    const folder = use(WorkspaceFolder);
    const reviewsOffered = useReviewsOffered();
    // A version the conversation replaced only lists its files: its turn's undo belongs to the past,
    // and so does a review of them.
    const live = !replaced && turnFiles !== undefined;
    return (
      <TurnChanges
        changes={changes}
        actions={replaced ? undefined : turnFiles}
        review={
          live && reviewsOffered && threadId !== undefined && folder !== undefined
            ? { threadId: threadId as ThreadId, root: folder }
            : undefined
        }
      />
    );
  },
  (before, after) => before.replaced === after.replaced && same(before.changes, after.changes),
);

function SpawnCards({ spawns }: { spawns: ReadonlyArray<Block<"spawn">> }) {
  const { childState, childAgent, agentActions } = use(Actions);
  const counts = { running: 0, idle: 0, failed: 0, needsYou: 0 };
  for (const spawn of spawns) {
    counts[childState(spawn.childId)]++;
  }
  const status = (
    <span className="inline-flex flex-wrap gap-x-2 text-caption font-normal">
      {counts.running > 0 ? <span className="text-running">{counts.running} working</span> : null}
      {counts.idle > 0 ? <span className="text-fg-tertiary">{counts.idle} done</span> : null}
      {counts.failed > 0 ? <span className="text-error-text">{counts.failed} failed</span> : null}
      {counts.needsYou > 0 ? <span className="text-attention-text">{counts.needsYou} need you</span> : null}
    </span>
  );
  return (
    <Disclosure
      defaultOpen
      summary={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
          <span>Spawned {spawns.length === 1 ? "an agent" : `${spawns.length} agents`}</span>
          {status}
        </span>
      }
    >
      {/* The team as a roster: who, on which model and with what access, and how each is getting on.
          One grid for the list, so every row's role, model and state line up. */}
      <ul className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 divide-y divide-line-subtle overflow-hidden rounded-lg border border-line-subtle md:grid-cols-[auto_fit-content(14rem)_minmax(0,1fr)_auto]">
        {spawns.map((spawn) => (
          <li key={spawn.id} className="col-span-full grid grid-cols-subgrid">
            <SpawnCard
              block={spawn}
              state={childState(spawn.childId)}
              agent={childAgent(spawn.childId)}
              actions={agentActions}
            />
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

const emptyLive: ReadonlyMap<string, AgentEvent> = new Map();
const LiveText = createContext(emptyLive);

/** `quiet` for a message the agent wrote along the way, which sits in its work under the final one. */
function ResponseBlock({
  block,
  activity,
  quiet,
  replaced,
}: {
  block: TranscriptBlock;
  activity: AgentActivity;
  quiet: boolean;
  replaced: boolean;
}) {
  const payload = use(LiveText).get(block.id)?.payload;
  const text =
    payload?._tag === "MessageDelta" || payload?._tag === "ReasoningDelta" ? payload.text : undefined;
  switch (block.kind) {
    case "notice":
      return <NoticeBlock block={block} />;
    case "message":
      return <ReplyMessage block={block} text={text ?? block.text} quiet={quiet} replaced={replaced} />;
    case "reasoning":
      return <Reasoning block={text === undefined ? block : { ...block, text }} />;
    case "permission":
      return <PermissionBlock block={block} expired={activity === "ended"} />;
    case "question":
      return <QuestionBlock block={block} expired={activity === "ended"} />;
    case "error":
      return <p className="text-body text-fg-secondary">{block.message}</p>;
    case "limit":
      return <LimitNote block={block} />;
    case "compacted":
      return <Compaction block={block} />;
    default:
      return null;
  }
}

function ReplyMessage({
  block,
  text,
  quiet,
  replaced,
}: {
  block: Block<"message">;
  text: string;
  quiet: boolean;
  replaced: boolean;
}) {
  const { onAddTask } = use(Actions);
  const fork = useTurnFork(replaced ? undefined : block.forkTurn, text);
  return (
    <>
      <MessageMenuArea
        text={text}
        className="select-text"
        onFork={fork.open}
        onAddTask={onAddTask}
        actionsOnHover
      >
        <div data-reply-source data-find={block.id}>
          <Markdown text={text} streaming={block.streaming} compact={quiet} />
        </div>
      </MessageMenuArea>
      {fork.dialog}
    </>
  );
}

function useTurnFork(turn: string | undefined, message: string) {
  const { fork } = use(Actions);
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<ForkCheck>({ status: "loading" });
  const asked = useRef(0);
  if (fork === undefined || turn === undefined) return {};
  return {
    open: () => {
      const ask = ++asked.current;
      setCheck({ status: "loading" });
      setOpen(true);
      fork.preview(turn).then(
        ({ snapshot }) => {
          if (ask === asked.current) setCheck({ status: "ready", snapshot });
        },
        () => {
          if (ask === asked.current) setCheck({ status: "failed" });
        },
      );
    },
    dialog: open ? (
      <ForkDialog
        open={open}
        onOpenChange={setOpen}
        message={message}
        actions={fork}
        check={check}
        onFork={(choice) => fork.fork({ turn, ...choice })}
      />
    ) : null,
  };
}

/**
 * One of the user's messages, which they can edit and send again, or restore the thread to before,
 * unless a rewind replaced it.
 */
function EditableMessage({ block, replaced }: { block: Block<"user">; replaced: boolean }) {
  const { onEditMessage, onAddTask, restore } = use(Actions);
  const messageBox = useMessageBox();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [check, setCheck] = useState<RestoreCheck>({ status: "loading" });
  /** The latest preview asked for, so an earlier one answering late is dropped. */
  const asked = useRef(0);
  const restorable = restore !== undefined && !replaced;
  const fork = useTurnFork(replaced ? undefined : block.forkTurn, block.text);

  const openRestore = () => {
    if (!restore) return;
    const ask = ++asked.current;
    setCheck({ status: "loading" });
    setRestoreOpen(true);
    restore.preview(block.id).then(
      (preview) => {
        if (ask === asked.current) setCheck({ status: "ready", preview });
      },
      (error: unknown) => {
        if (ask === asked.current) setCheck({ status: "failed", message: previewFailure(error) });
      },
    );
  };

  return (
    <>
      <UserMessage
        block={block}
        onEdit={
          onEditMessage && !replaced
            ? (message: OutgoingMessage) => onEditMessage(block.id, message)
            : undefined
        }
        onRestore={restorable ? openRestore : undefined}
        onFork={fork.open}
        onAddTask={onAddTask}
      />
      {fork.dialog}
      {restorable ? (
        <RestoreDialog
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          message={block.text.trim()}
          harness={restore.harness}
          check={check}
          onRestore={async () => {
            const done = await restore.restore(block.id);
            // The message comes back to the box, to send again as it was or changed.
            if (done) {
              messageBox?.append({
                segments: segmentsOf(block.text.trim(), block.mentions),
                attachments: block.attachments,
              });
            }
            return done;
          }}
        />
      ) : null}
    </>
  );
}

/** The turns the conversation went back on, folded under one line until the user opens them. */
function EarlierVersion({
  item,
  turns,
  files,
  children,
}: {
  item: Extract<Item, { kind: "replaced" }>;
  turns: number;
  /** The files a restore put back, when it did. */
  files: number | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const reveal = useEffectEvent((event: Event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id !== undefined && containsBlock(item, id)) setOpen(true);
  });
  useEffect(() => {
    const listener = (event: Event) => reveal(event);
    window.addEventListener("cerium:history", listener);
    return () => window.removeEventListener("cerium:history", listener);
  }, []);
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      summary={
        <span className="flex items-center gap-1.5">
          <History size={13} strokeWidth={1.75} className="text-fg-tertiary" />
          Earlier version
        </span>
      }
      hint={[
        turns === 1 ? "1 turn" : `${turns} turns`,
        ...(files === undefined ? [] : [files === 1 ? "1 file put back" : `${files} files put back`]),
      ].join(" · ")}
    >
      <div className="flex flex-col gap-3 border-l border-line-subtle pl-4 opacity-75">{children}</div>
    </Disclosure>
  );
}

function PushItem({ call }: { call: Block<"tool"> }) {
  const { threadId } = use(Actions);
  return <PushCard call={call} threadId={threadId as ThreadId | undefined} />;
}

function NoticeBlock({ block }: { block: Block<"notice"> }) {
  const { roleOf, providerOf } = use(Actions);
  return <Notice block={block} roleOf={roleOf} providerOf={providerOf} />;
}

function PermissionBlock({ block, expired }: { block: Block<"permission">; expired: boolean }) {
  const { onAnswerPermission } = use(Actions);
  return (
    <PermissionCard
      block={block}
      expired={expired}
      onAnswer={(decision, scope) =>
        onAnswerPermission?.(block.id.replace(/^permission:/, ""), decision, scope)
      }
    />
  );
}

function QuestionBlock({ block, expired }: { block: Block<"question">; expired: boolean }) {
  const { onAnswerQuestion } = use(Actions);
  if (block.resolution !== undefined || expired) {
    return <ClosedQuestions questions={block.questions} resolution={block.resolution} />;
  }
  return (
    <QuestionCard
      key={block.requestId}
      questions={block.questions}
      askedAt={block.at}
      onAnswer={onAnswerQuestion && ((response) => onAnswerQuestion(block.requestId, response))}
    />
  );
}
