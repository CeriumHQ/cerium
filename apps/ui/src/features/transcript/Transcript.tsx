import { Button } from "@base-ui/react/button";
import type { ProviderId, QuestionResponse } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDown } from "lucide-react";
import { createContext, memo, use, type CSSProperties, type ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { useKeyboardOpen } from "../../web/viewport.ts";
import type { AgentActions } from "../agents/AgentMenu.tsx";
import type { AgentSummary } from "../agents/model.ts";
import { MessageBoxContext, type MessageBox } from "../composer/messageBox.ts";
import { ClosedQuestions, QuestionCard } from "../questions/QuestionCard.tsx";
import { textScale, textSizeAtom } from "../settings/preferences.ts";
import {
  ModelSwitch,
  Notice,
  PermissionCard,
  QueuedInput,
  Reasoning,
  SpawnAsk,
  SpawnCard,
  TurnFooter,
  UserMessage,
  Working,
  type ChildState,
} from "./Blocks.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import { currentModel, layout, showsProgress, type Item } from "./layout.ts";
import { Markdown } from "./Markdown.tsx";
import { MessageMenuArea } from "./MessageMenu.tsx";
import type { AgentActivity, QueuedMessages, TranscriptBlock } from "./model.ts";
import { ToolGroup, ToolRun } from "./ToolGroup.tsx";
import { useStickToBottom } from "./useStickToBottom.ts";

interface TranscriptProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  /** The user's messages that haven't reached the agent yet. */
  readonly queued: QueuedMessages;
  /** The lead's provider, and the model it runs on now, which labels a response with no model of its own. */
  readonly agent: { readonly provider: ProviderId; readonly model: string };
  /** A model's id as people know it ("Opus 5.5"); without it, responses show the id. */
  readonly modelName?: ((model: string) => string) | undefined;
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
}

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

/**
 * What an earlier response's footer wears so it stays out of sight until its response is under the
 * pointer or has focus (touch screens, which can't hover, always show it). The latest response's
 * footer, and any that says the turn was cut short, stay in view. `:hover+&` is the item just
 * before the footer, which is the response's last part.
 */
const quietFooter = (item: Extract<Item, { kind: "turnEnd" }>, latest: string | undefined) =>
  item.id === latest || item.block.stopReason !== "completed"
    ? ""
    : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 [:focus-within+&]:opacity-100 [:hover+&]:opacity-100";

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
}: TranscriptProps) {
  const roles = new Map(
    blocks.flatMap((block) => (block.kind === "spawn" ? [[block.childId, block.role] as const] : [])),
  );
  const roleOf = (agentId: string) => roles.get(agentId) ?? "An agent";
  // Messages waiting for the agent's session read as sent, with its progress below them. Ones that
  // wait behind a running turn, or for an ended agent to start again, sit after it and say so.
  const held =
    queued.messages.length > 0 && (activity === "ended" || (activity === "running" && queued.behindTurn));
  const shown = held ? blocks : [...blocks, ...queued.messages];
  const { viewport, following, toEnd } = useStickToBottom(
    queued.messages.at(-1)?.id ?? blocks.findLast((block) => block.kind === "user")?.id,
  );
  const items = layout(shown);
  const last = items.at(-1);
  const latestFooter = items.findLast((item) => item.kind === "turnEnd")?.id;
  const working = activity === "running" && !showsProgress(last);
  // A response labels itself with the model it ran on, which the thread's events say; the model it
  // runs on now is only for one that hasn't started and for threads that never said.
  const modelLabel = (model: string | undefined) =>
    model === undefined ? agent.model : (modelName?.(model) ?? model);
  const responding =
    items.findLast((item) => item.kind === "header" || item.kind === "input")?.kind === "header";
  // The chosen text size scales the whole column, so icons and spacing keep their proportions.
  const scale = textScale(useAtomValue(textSizeAtom));
  // A phone's keyboard shrinks the message box to one line, so the end needs less room.
  const oneLine = useKeyboardOpen();
  const actions: TranscriptActions = {
    roleOf,
    childState,
    childAgent,
    agentActions,
    ...(onAnswerPermission ? { onAnswerPermission } : {}),
    ...(onAnswerQuestion ? { onAnswerQuestion } : {}),
  };

  return (
    <ThreadContext folder={folder} messageBox={messageBox} actions={actions}>
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
            className="mx-auto flex max-w-[50.2rem] flex-col gap-3 px-4 pt-5 md:px-8 md:pt-8"
            // The inset is in screen pixels; the column's zoom would scale it.
            style={{
              zoom: scale,
              paddingBottom: `max(${oneLine ? "5rem" : "10rem"}, calc(${bottomInset / scale}px + ${oneLine ? "1.5rem" : "3rem"}))`,
            }}
          >
            {/* Every item is laid out for real. `content-visibility: auto` skipped those out of view
                on a guessed height, so scrolling up through unseen items swapped each guess for its
                true height, and the content jumped under the scroll position. */}
            {items.map((item) => (
              <div
                key={item.id}
                className={item.kind === "turnEnd" ? quietFooter(item, latestFooter) : undefined}
              >
                <TranscriptItem
                  item={item}
                  last={item === last}
                  activity={activity}
                  provider={agent.provider}
                  model={item.kind === "header" || item.kind === "switch" ? modelLabel(item.model) : ""}
                />
              </div>
            ))}
            {working && !responding ? (
              <ResponseHeader agent={{ provider: agent.provider, model: modelLabel(currentModel(shown)) }} />
            ) : null}
            {working ? <Working /> : null}
            {held ? (
              <QueuedInput
                messages={queued.messages}
                note={
                  activity === "ended"
                    ? "Not sent yet · goes with your next message"
                    : "Queued · sends when this turn ends"
                }
              />
            ) : null}
          </div>
        </ScrollArea>
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
      </div>
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
}

/**
 * One item of the conversation. Only an item whose content changed renders again: while an agent
 * streams, that's the reply at the end. Re-rendering every earlier item for each streamed word made
 * a long thread's updates three times as slow (scratch transcript benchmark, 1,900 events).
 */
const TranscriptItem = memo(
  function TranscriptItem({ item, last, activity, provider, model }: ItemProps) {
    const render = (each: Item): ReactNode => {
      switch (each.kind) {
        case "input":
          return (
            <div key={each.id} className="flex flex-col items-end gap-2 py-3">
              {each.blocks.map((block) =>
                block.kind === "user" ? <UserMessage key={block.id} block={block} /> : null,
              )}
            </div>
          );
        case "header":
          return <ResponseHeader key={each.id} agent={{ provider, model }} />;
        case "switch":
          return (
            <ModelSwitch
              key={each.id}
              model={model}
              {...(each.effort ? { effort: each.effort } : {})}
              change={each.change}
            />
          );
        case "run":
          return (
            <ToolRun
              key={each.id}
              tools={each.steps.flatMap((step) => (step.kind === "tools" ? step.tools : []))}
              live={last && activity === "running"}
              activity={activity}
            >
              {each.steps.map(render)}
            </ToolRun>
          );
        case "tools":
          return <ToolGroup key={each.id} tools={each.tools} activity={activity} />;
        case "spawns":
          return <SpawnCards key={each.id} spawns={each.spawns} />;
        case "spawnAsk":
          return <SpawnAsk key={each.id} call={each.call} />;
        case "block":
          return <ResponseBlock key={each.id} block={each.block} activity={activity} />;
        case "turnEnd":
          return <TurnFooter key={each.id} block={each.block} text={each.text} />;
      }
    };
    return render(item);
  },
  (before, after) =>
    before.last === after.last &&
    before.activity === after.activity &&
    before.provider === after.provider &&
    before.model === after.model &&
    same(before.item, after.item),
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

export function ResponseHeader({ agent }: { agent: TranscriptProps["agent"] }) {
  return (
    <div className="flex items-center gap-2 pt-2 text-xs text-fg-tertiary">
      <span className="grid size-5 place-items-center rounded-md border border-line-subtle bg-surface-raised text-fg-primary">
        <ProviderLogo provider={agent.provider} size={11} />
      </span>
      <span className="font-medium text-fg-secondary">{agent.model}</span>
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
          <Markdown text={block.text} streaming={block.streaming} />
        </MessageMenuArea>
      );
    case "reasoning":
      return <Reasoning block={block} />;
    case "permission":
      return <PermissionBlock block={block} expired={activity === "ended"} />;
    case "question":
      return <QuestionBlock block={block} expired={activity === "ended"} />;
    case "error":
      return <p className="text-[13px] text-fg-secondary">{block.message}</p>;
    default:
      return null;
  }
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
      onAnswer={onAnswerQuestion && ((response) => onAnswerQuestion(block.requestId, response))}
    />
  );
}
