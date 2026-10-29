import { Button } from "@base-ui/react/button";
import type { ProviderId, QuestionResponse, RestorePreview, ThreadId } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDown, History } from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  use,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { ImageGallery } from "../../components/ImageViewer.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
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
  ModelSwitch,
  Notice,
  PermissionCard,
  Reasoning,
  RoutedEffort,
  SpawnAsk,
  SpawnCard,
  TurnFooter,
  UserMessage,
  Working,
  type ChildState,
} from "./Blocks.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import { currentModel, layout, pendingRouted, runTimings, showsProgress, type Item } from "./layout.ts";
import { Markdown } from "./Markdown.tsx";
import { MessageMenuArea } from "./MessageMenu.tsx";
import {
  holdsQueue,
  type AgentActivity,
  type QueuedMessages,
  type RoutedDecision,
  type TranscriptBlock,
  type TurnChanges as TurnChangesModel,
} from "./model.ts";
import { PromptStepper, promptsOf } from "./PromptStepper.tsx";
import { PushCard } from "./PushCard.tsx";
import { previewFailure } from "./restore.ts";
import { RestoreDialog, type RestoreCheck } from "./RestoreDialog.tsx";
import { SelectionReply } from "./SelectionReply.tsx";
import { TranscriptFind } from "./FindBar.tsx";
import { ToolGroup, ToolRun } from "./ToolGroup.tsx";
import { threadImages } from "./tools.ts";
import { TurnChanges, type TurnFileActions } from "./TurnChanges.tsx";
import { useStickToBottom } from "./useStickToBottom.ts";
import { useArrivals } from "../../lib/motion.ts";
import { HistoryWindow } from "./HistoryWindow.tsx";

interface TranscriptProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  /** The user's messages that haven't reached the agent yet. */
  readonly queued: QueuedMessages;
  /** The lead's provider, and the model it runs on now, which labels a response with no model of its own. */
  readonly agent: { readonly provider: ProviderId; readonly model: string };
  /** A model's id as people know it ("Opus 5.5"); without it, responses show the id. */
  readonly modelName?: ((model: string, provider: ProviderId) => string) | undefined;
  /** The thread's folder, which paths in the conversation are relative to; absent for chats. */
  readonly folder?: string | undefined;
  /** The thread's message box, which messages and chips can put content into; absent when closed. */
  readonly messageBox?: MessageBox | undefined;
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
  /** Opens the files a turn changed and undoes them; without it, a turn's files are only listed. */
  readonly turnFiles?: TurnFileActions | undefined;
  /** The thread the conversation is of, which a message a palette search picked is found in. */
  readonly threadId?: string | undefined;
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
 * How an item comes in while the thread is open, by what it is: a line writes itself out in reading
 * order, a card or a whole message unrolls downward, and the footer trails in last. Decided by the
 * item's kind alone, which never changes for its id, so an item keeps its entrance as it updates and
 * plays it only as it first mounts.
 */
const entrance = (item: Item): string => {
  switch (item.kind) {
    case "input":
      return "arrive";
    // A response's header takes the place of the one shown while it was awaited, which already came in.
    case "header":
    // A run writes in its own line, and brings in each of its steps as they come.
    case "run":
    case "replaced":
      return "";
    case "tools":
      return "unroll";
    case "spawns":
      return "arrive-spawns";
    case "turnEnd":
      return "trail";
    case "routed":
    case "switch":
    case "imported":
    case "spawnAsk":
      return "write-in";
    case "push":
      return "unroll";
    case "block":
      switch (item.block.kind) {
        case "message":
          return "unroll";
        case "permission":
        case "question":
          return "unroll asks";
        default:
          return "write-in";
      }
  }
};

/** Every item's id, and those of the steps inside runs, which come in one by one as a run grows. */
const arrivalKeys = (items: ReadonlyArray<Item>) =>
  items.flatMap((item) =>
    item.kind === "run" ? [item.id, ...item.steps.map((step) => step.id)] : [item.id],
  );

export function Transcript({
  blocks,
  queued,
  agent,
  modelName,
  folder,
  messageBox,
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
  turnFiles,
  threadId,
  focused = false,
}: TranscriptProps) {
  // Read from the spawns as text, which stays equal while they do, so `actions` below stays the same
  // object: every card that reads it renders again when it changes, which was every streamed batch.
  const spawned = JSON.stringify(
    blocks.flatMap((block) => (block.kind === "spawn" ? [[block.childId, block.role]] : [])),
  );
  const roleOf = useMemo(() => {
    const roles = new Map<string, string>(JSON.parse(spawned) as Array<[string, string]>);
    return (agentId: string) => roles.get(agentId) ?? "An agent";
  }, [spawned]);
  // Messages waiting for the agent's session read as sent, with its progress below them. Ones that
  // wait behind a running turn, or for an ended agent to start again, wait in the message box.
  // Other threads' messages for its next turn show where they came in.
  const shown = holdsQueue(queued, activity)
    ? [...blocks, ...queued.held]
    : [...blocks, ...queued.held, ...queued.messages];
  const { viewport, following, toEnd } = useStickToBottom(
    queued.messages.at(-1)?.id ?? blocks.findLast((block) => block.kind === "user")?.id,
  );
  const items = layout(shown);
  // What comes in while the thread is open rises into place; what it opened with stays still.
  const arrived = useArrivals(arrivalKeys(items));
  const last = items.at(-1);
  const latestFooter = items.findLast((item) => item.kind === "turnEnd")?.id;
  const working = activity === "running" && !showsProgress(last);
  // A response labels itself with the model it ran on, which the thread's events say; the model it
  // runs on now is only for one that hasn't started and for threads that never said.
  const modelLabel = (model: string | undefined, provider: ProviderId | undefined) =>
    model === undefined ? agent.model : (modelName?.(model, provider ?? agent.provider) ?? model);
  const responding =
    items.findLast((item) => item.kind === "header" || item.kind === "input")?.kind === "header";
  // The chosen text size scales the whole column, so icons and spacing keep their proportions.
  const scale = textScale(useAtomValue(textSizeAtom));
  // A phone's keyboard shrinks the message box to one line, so the end needs less room.
  const oneLine = useKeyboardOpen();
  const column = useRef<HTMLDivElement>(null);
  const actions: TranscriptActions = {
    roleOf,
    childState,
    childAgent,
    agentActions,
    ...(onAnswerPermission ? { onAnswerPermission } : {}),
    ...(onAnswerQuestion ? { onAnswerQuestion } : {}),
    ...(onEditMessage ? { onEditMessage } : {}),
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
      <EarlierVersion key={item.id} turns={item.turns} files={item.files}>
        {item.items.map((each) => renderItem(each, true))}
      </EarlierVersion>
    ) : (
      <Fragment key={item.id}>
        {/* The files the turn changed stay in view, above the footer that hides until hovered. */}
        {item.kind === "turnEnd" && item.block.changes !== undefined ? (
          <div className={!replaced && arrived(item.id) ? "unroll" : ""}>
            <TurnChangesItem changes={item.block.changes} replaced={replaced} />
          </div>
        ) : null}
        <div
          // A message sent rises out of the message box, its text flying there from where it was written.
          {...(item.kind === "input" ? { "data-from-box": "" } : {})}
          // The prompt stepper finds a prompt to bring into view by it.
          {...(item.kind === "input" && !replaced ? { "data-prompt": item.id } : {})}
          className={`${item.kind === "turnEnd" ? quietFooter(item, replaced ? undefined : latestFooter) : ""} ${
            !replaced && arrived(item.id) ? entrance(item) : ""
          }`}
        >
          <TranscriptItem
            item={item}
            last={!replaced && item === last}
            activity={replaced ? "ended" : activity}
            provider={
              (item.kind === "header" || item.kind === "switch" ? item.provider : undefined) ?? agent.provider
            }
            model={
              item.kind === "header" || item.kind === "switch" ? modelLabel(item.model, item.provider) : ""
            }
            replaced={replaced}
            fresh={
              !replaced && item.kind === "run"
                ? [item.id, ...item.steps.map((step) => step.id)].filter(arrived).join(" ")
                : ""
            }
          />
        </div>
      </Fragment>
    );

  return (
    <ThreadContext folder={folder} messageBox={messageBox} actions={actions}>
      {/* An image opened from the conversation steps through all of the thread's others. */}
      <ImageGallery images={() => threadImages(shown)}>
        <div className="relative h-full" style={{ "--composer": `${bottomInset}px` } as CSSProperties}>
          {/* Content fades out where the floating composer sits instead of showing through its glass. */}
          <ScrollArea
            viewportRef={viewport}
            className={`h-full ${
              oneLine
                ? "mask-b-from-[calc(100%_-_max(4.5rem,_var(--composer)_+_1rem))] mask-b-to-[calc(100%_-_max(1rem,_var(--composer)_-_2.5rem))]"
                : "mask-b-from-[calc(100%_-_max(9rem,_var(--composer)_+_2rem))] mask-b-to-[calc(100%_-_max(2rem,_var(--composer)_-_5rem))]"
            }`}
          >
            <div
              ref={column}
              className="mx-auto flex max-w-[50.2rem] flex-col gap-3 px-4 pt-5 md:px-8 md:pt-8"
              // The inset is in screen pixels; the column's zoom would scale it.
              style={{
                zoom: scale,
                paddingBottom: `max(${oneLine ? "5rem" : "10rem"}, calc(${bottomInset / scale}px + ${oneLine ? "1.5rem" : "3rem"}))`,
              }}
            >
              <HistoryWindow items={items} viewport={viewport} render={(item) => renderItem(item, false)} />
              {working && !responding ? (
                <div className="arrive-header">
                  <ResponseHeader
                    agent={{
                      provider: agent.provider,
                      model: modelLabel(currentModel(shown), agent.provider),
                    }}
                    routed={pendingRouted(shown)}
                  />
                </div>
              ) : null}
              {working ? (
                <div className="arrive-late">
                  <Working />
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <PromptStepper prompts={promptsOf(items)} viewport={viewport} />
          <SelectionReply within={column} />
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
          <TranscriptFind scope={column} threadId={threadId} focused={focused} blocks={shown} />
        </div>
      </ImageGallery>
    </ThreadContext>
  );
}

/**
 * What the transcript's cards ask about agents and do for the user. The window makes these afresh
 * on every update, so they reach the few cards that use them through context rather than as props
 * of every item, which would re-render the whole conversation for each streamed word.
 */
interface TranscriptActions {
  readonly roleOf: (agentId: string) => string;
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
  readonly turnFiles?: TurnFileActions | undefined;
  /** The thread shown, whose pushes its push cards follow. */
  readonly threadId?: string | undefined;
}

const Actions = createContext<TranscriptActions>({
  roleOf: () => "An agent",
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
  return (
    <WorkspaceFolder value={folder}>
      <MessageBoxContext value={messageBox}>
        <Actions value={actions}>{children}</Actions>
      </MessageBoxContext>
    </WorkspaceFolder>
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
  /** For a run, the ids of it and its steps that came in while the thread was open, space-separated. */
  readonly fresh: string;
}

/**
 * One item of the conversation. Only an item whose content changed renders again: while an agent
 * streams, that's the reply at the end. Re-rendering every earlier item for each streamed word made
 * a long thread's updates three times as slow (scratch transcript benchmark, 1,900 events).
 */
const TranscriptItem = memo(
  function TranscriptItem({ item, last, activity, provider, model, replaced, fresh }: ItemProps) {
    const arrived = new Set(fresh.split(" "));
    const render = (each: Item): ReactNode => {
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
        case "header":
          return <ResponseHeader key={each.id} agent={{ provider, model }} routed={each.routed} />;
        case "routed":
          return each.decision.effort === undefined ? null : (
            <div key={each.id} className="flex text-meta text-fg-tertiary">
              <RoutedEffort routed={each.decision} />
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
              tools={each.steps.flatMap((step) => (step.kind === "tools" ? step.tools : []))}
              timings={runTimings(each.steps)}
              live={last && activity === "running"}
              activity={activity}
              arrived={arrived.has(each.id)}
            >
              {each.steps.map((step) => (
                <div key={step.id} className={arrived.has(step.id) ? entrance(step) : ""}>
                  {render(step)}
                </div>
              ))}
            </ToolRun>
          );
        case "tools":
          return <ToolGroup key={each.id} tools={each.tools} activity={activity} />;
        case "spawns":
          return <SpawnCards key={each.id} spawns={each.spawns} />;
        case "spawnAsk":
          return <SpawnAsk key={each.id} call={each.call} />;
        case "push":
          return <PushItem key={each.id} call={each.call} />;
        case "block":
          return <ResponseBlock key={each.id} block={each.block} activity={activity} />;
        case "turnEnd":
          return <TurnFooter key={each.id} block={each.block} text={each.text} />;
        // Laid out by the transcript itself, around the items it holds.
        case "replaced":
          return null;
      }
    };
    return render(item);
  },
  (before, after) =>
    before.last === after.last &&
    before.activity === after.activity &&
    before.provider === after.provider &&
    before.model === after.model &&
    before.replaced === after.replaced &&
    before.fresh === after.fresh &&
    same(before.item, after.item),
);

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
  return (
    <div className="flex flex-wrap gap-1.5">
      {spawns.map((spawn) => (
        <SpawnCard
          key={spawn.id}
          block={spawn}
          state={childState(spawn.childId)}
          agent={childAgent(spawn.childId)}
          actions={agentActions}
        />
      ))}
    </div>
  );
}

/** The start of a response: the model it ran on and, for an agent on Auto, the effort the router chose. */
export function ResponseHeader({
  agent,
  routed,
}: {
  agent: TranscriptProps["agent"];
  routed?: RoutedDecision | undefined;
}) {
  return (
    <div className="flex items-center gap-2 pt-2 text-meta text-fg-tertiary">
      <span
        data-header-mark
        className="grid size-5 place-items-center rounded-md border border-line-subtle bg-surface-raised text-fg-primary"
      >
        <ProviderLogo provider={agent.provider} size={11} />
      </span>
      <span data-header-name className="font-medium text-fg-secondary">
        {agent.model}
      </span>
      {routed?.effort === undefined ? null : <RoutedEffort routed={routed} />}
    </div>
  );
}

function ResponseBlock({ block, activity }: { block: TranscriptBlock; activity: AgentActivity }) {
  switch (block.kind) {
    case "notice":
      return <NoticeBlock block={block} />;
    case "message":
      return (
        <MessageMenuArea text={block.text} className="select-text">
          <div data-reply-source data-find={block.id}>
            <Markdown text={block.text} streaming={block.streaming} />
          </div>
        </MessageMenuArea>
      );
    case "reasoning":
      return <Reasoning block={block} />;
    case "permission":
      return <PermissionBlock block={block} expired={activity === "ended"} />;
    case "question":
      return <QuestionBlock block={block} expired={activity === "ended"} />;
    case "error":
      return <p className="text-body text-fg-secondary">{block.message}</p>;
    case "compacted":
      return <Compaction block={block} />;
    default:
      return null;
  }
}

/**
 * One of the user's messages, which they can edit and send again, or restore the thread to before,
 * unless a rewind replaced it.
 */
function EditableMessage({ block, replaced }: { block: Block<"user">; replaced: boolean }) {
  const { onEditMessage, restore } = use(Actions);
  const messageBox = useMessageBox();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [check, setCheck] = useState<RestoreCheck>({ status: "loading" });
  /** The latest preview asked for, so an earlier one answering late is dropped. */
  const asked = useRef(0);
  const restorable = restore !== undefined && !replaced;

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
      />
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
  turns,
  files,
  children,
}: {
  turns: number;
  /** The files a restore put back, when it did. */
  files: number | undefined;
  children: ReactNode;
}) {
  return (
    <Disclosure
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
  const { roleOf } = use(Actions);
  return <Notice block={block} roleOf={roleOf} />;
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
