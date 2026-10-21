import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import type { ReasoningEffort } from "@cerium/protocol";
import {
  ArrowRightLeft,
  Ban,
  Brain,
  Check,
  ChevronRight,
  Clock,
  CornerDownRight,
  Pencil,
  RotateCcw,
  Split,
  Workflow,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { FileImageThumb } from "../../components/ImageThumb.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { compactTokens, usd } from "../../lib/format.ts";
import { AgentMenuArea, type AgentActions } from "../agents/AgentMenu.tsx";
import { PermissionPrompt } from "../agents/ApprovalParts.tsx";
import { accessLabel, type AgentSummary } from "../agents/model.ts";
import type { OutgoingMessage } from "../composer/Composer.tsx";
import { segmentsOf } from "../composer/draft.ts";
import { useMessageBox } from "../composer/messageBox.ts";
import { effortLabel } from "../composer/models.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FileChip } from "./FileChip.tsx";
import { FoldedText } from "./FoldedText.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageEditor } from "./MessageEditor.tsx";
import { MessageMenuArea } from "./MessageMenu.tsx";
import type { TranscriptBlock, UserBlock } from "./model.ts";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

/** A quiet button beside a message's foot, out of the way until the message is under the pointer. */
const footButton =
  "grid size-7 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[color,background-color,opacity] duration-150 group-hover/user:opacity-100 hover:bg-surface-hover hover:text-fg-secondary focus-visible:opacity-100 pointer-coarse:opacity-100";

export function UserMessage({
  block,
  onEdit,
  onRestore,
}: {
  block: Block<"user">;
  /** Sends a new version of the message; resolves whether it went. Absent where it can't be edited. */
  onEdit?: ((message: OutgoingMessage) => Promise<boolean>) | undefined;
  /** Asks to restore the thread to before the message. Absent where it can't be. */
  onRestore?: (() => void) | undefined;
}) {
  const images = block.attachments.filter((attachment) => attachment.mediaType.startsWith("image/"));
  const files = block.attachments.filter((attachment) => !attachment.mediaType.startsWith("image/"));
  const messageBox = useMessageBox();
  const [editing, setEditing] = useState(false);
  const editable = onEdit !== undefined && block.delivered === true;
  // A message the agent never got began nothing to go back on.
  const restorable = onRestore !== undefined && block.delivered === true;
  if (editing && editable) {
    return <MessageEditor block={block} onSend={onEdit} onCancel={() => setEditing(false)} />;
  }
  return (
    <MessageMenuArea
      text={block.text.trim()}
      onCopyToMessageBox={
        messageBox
          ? () =>
              messageBox.append({
                segments: segmentsOf(block.text.trim(), block.mentions),
                attachments: block.attachments,
              })
          : undefined
      }
      onEdit={editable ? () => setEditing(true) : undefined}
      onRestore={restorable ? onRestore : undefined}
      className="group/user relative flex max-w-[85%] flex-col items-end gap-1.5"
    >
      {editable || restorable ? (
        <div className="absolute right-full bottom-0.5 mr-1 flex">
          {restorable ? (
            <Tooltip label="Restore to before this message">
              <Button aria-label="Restore to before this message" onClick={onRestore} className={footButton}>
                <RotateCcw size={13} strokeWidth={1.75} />
              </Button>
            </Tooltip>
          ) : null}
          {editable ? (
            <Tooltip label="Edit message">
              <Button aria-label="Edit message" onClick={() => setEditing(true)} className={footButton}>
                <Pencil size={13} strokeWidth={1.75} />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {block.writtenIn === undefined ? null : (
        <p className="flex max-w-full min-w-0 items-center gap-1.5 text-[12px] text-fg-tertiary">
          <Split size={12} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">
            Started from <span className="font-medium text-fg-secondary">{block.writtenIn}</span>
          </span>
        </p>
      )}
      {block.attachments.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((image) => (
            <FileImageThumb
              key={image.path}
              path={image.path}
              name={image.name}
              className="h-32 max-w-full min-w-16"
              fit="natural"
            />
          ))}
          {files.map((file) => (
            <span key={file.path} className="text-[13px]">
              <FileChip path={file.path} folder={false} />
            </span>
          ))}
        </div>
      ) : null}
      {block.text.trim() === "" ? null : (
        <div className="max-w-full rounded-2xl rounded-br-md border border-line-subtle bg-surface-raised px-4 py-2.5 shadow-raised select-text">
          <FoldedText text={block.text}>
            <Markdown text={block.text} streaming={false} user={{ mentions: block.mentions }} />
          </FoldedText>
        </div>
      )}
    </MessageMenuArea>
  );
}

/** The user's messages waiting to reach the agent, with why they wait. */
export function QueuedInput({
  messages,
  note,
  onSteer,
}: {
  messages: ReadonlyArray<UserBlock>;
  note: string;
  /** Interrupts the agent to send the messages now. Absent where they can only wait. */
  onSteer?: (() => void) | undefined;
}) {
  // Pressed once per wait: the turn's end brings the messages in, and this button goes with them.
  const [steered, setSteered] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2 py-3">
      <div className="flex w-full flex-col items-end gap-2 opacity-70">
        {messages.map((block) => (
          <UserMessage key={block.id} block={block} />
        ))}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-fg-tertiary">
        <p className="flex items-center gap-1.5">
          <Clock size={12} strokeWidth={1.75} />
          {steered ? "Steering…" : note}
        </p>
        {onSteer && !steered ? (
          <Tooltip label="Interrupt the agent and send now">
            <Button
              onClick={() => {
                setSteered(true);
                onSteer();
              }}
              className="flex h-6 items-center gap-1 rounded-md border border-line-subtle px-2 font-medium text-fg-secondary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-primary"
            >
              <CornerDownRight size={12} strokeWidth={1.75} />
              Steer
            </Button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

/** A child's result or another agent's message, delivered to this agent as input. */
export function Notice({ block, roleOf }: { block: Block<"notice">; roleOf: (agentId: string) => string }) {
  const { item } = block;
  const from =
    item._tag === "ChildFinishedTurn"
      ? item.role
      : item._tag === "FromAgent"
        ? roleOf(item.agentId)
        : "Cerium";
  const verb =
    item._tag === "ChildFinishedTurn" ? "finished" : item._tag === "FromAgent" ? "wrote" : "notice";
  const text = item.text.trim();
  const preview = previewLine(text);

  // A one-liner reads best as it is; anything longer folds behind its first line.
  if (preview === text) {
    return (
      <MessageMenuArea text={text} className="flex gap-2 text-[12.5px] leading-[1.55]">
        <CornerDownRight size={13} strokeWidth={1.75} className="mt-[3px] shrink-0 text-fg-tertiary" />
        <p className="min-w-0 text-fg-tertiary select-text">
          <span className="font-medium text-fg-secondary">{from}</span> {verb}: {text}
        </p>
      </MessageMenuArea>
    );
  }

  return (
    <MessageMenuArea text={text}>
      <Collapsible.Root>
        <Collapsible.Trigger className="group flex w-full min-w-0 items-center gap-2 text-left text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-secondary">
          <CornerDownRight size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="shrink-0">
            <span className="font-medium text-fg-secondary">{from}</span> {verb}
          </span>
          <span className="min-w-0 truncate group-data-panel-open:hidden">{preview}</span>
          <ChevronRight
            size={13}
            className="shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
          />
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
          <div className="mt-2 ml-[5.5px] border-l border-line-strong pl-[14px] select-text">
            <Markdown text={text} streaming={false} compact />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </MessageMenuArea>
  );
}

const previewMax = 160;

/** The first line of agent markdown as plain text, cut short, for a folded notice's header. */
function previewLine(text: string) {
  const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
  const plain = first
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|[-*+>]|\d+\.)\s+/, "")
    .replace(/[*_`~]+/g, "")
    .trim();
  if (first === text && plain === text && text.length <= previewMax) return text;
  return plain.length > previewMax ? `${plain.slice(0, previewMax).trimEnd()}…` : plain;
}

/** Shown while the agent works with nothing on screen moving: before its first output, between steps. */
export function Working() {
  return (
    <output className="block text-[12.5px]">
      <span className="text-shimmer">Working…</span>
    </output>
  );
}

/** Where the user switched the agent to another model, or just its effort. */
export function ModelSwitch({
  model,
  effort,
  change,
}: {
  /** The model as people know it. */
  model: string;
  effort?: ReasoningEffort;
  change: "model" | "effort";
}) {
  return (
    <p className="flex items-center gap-2 text-[12.5px] text-fg-tertiary">
      <ArrowRightLeft size={13} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 truncate">
        {change === "effort" ? (
          <>Effort set to {effort ? effortLabel[effort] : ""}</>
        ) : (
          <>
            Switched to <span className="font-medium text-fg-secondary">{model}</span>
            {effort ? ` · ${effortLabel[effort]}` : ""}
          </>
        )}
      </span>
    </p>
  );
}

export function Reasoning({ block }: { block: Block<"reasoning"> }) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex items-center gap-1.5 text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-secondary">
        <Brain size={13} strokeWidth={1.75} />
        {block.streaming ? <span className="text-shimmer">Thinking…</span> : "Thought"}
        <ChevronRight
          size={13}
          className="transition-transform duration-200 group-data-panel-open:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        {/* Reasoning is written as markdown too: paragraphs, lists and bold run-in headings. */}
        <div className="mt-1.5 border-l border-line-strong pl-3 select-text">
          <Markdown text={block.text} streaming={block.streaming} compact />
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** A spawned agent as its card shows it; `needsYou` while a request of its waits on the user. */
export type ChildState = "running" | "needsYou" | "idle" | "failed";

/** Opens the agent in the agents panel; right-click for its menu. */
export function SpawnCard({
  block,
  state,
  agent,
  actions,
}: {
  block: Block<"spawn">;
  state: ChildState;
  /** The child's live record, once it has one. */
  agent?: AgentSummary | undefined;
  actions: AgentActions;
}) {
  const card = (
    <Button
      onClick={() => actions.onShow?.(block.childId)}
      className="flex min-w-0 flex-[1_1_17rem] items-center gap-2 rounded-lg border border-line-subtle px-2.5 py-1.5 text-left text-[12.5px] transition-colors max-md:min-h-10 hover:border-line-strong hover:bg-surface-hover data-popup-open:border-line-strong data-popup-open:bg-surface-hover"
    >
      <ProviderLogo provider={block.provider} size={13} className="text-fg-primary" />
      <span className="truncate font-medium text-fg-primary">{block.role}</span>
      <span className="min-w-0 flex-1 truncate text-fg-tertiary">
        {block.model} · {accessLabel[block.access]}
      </span>
      <AgentState state={state} />
    </Button>
  );
  return agent ? (
    <AgentMenuArea agent={agent} actions={actions} card>
      {card}
    </AgentMenuArea>
  ) : (
    card
  );
}

/**
 * A request to start an agent that waits for the user's approval. It makes no card until the user
 * says yes, so a quiet line records that it was made; a refusal arrives as a notice.
 */
export function SpawnAsk({ call }: { call: Block<"tool"> }) {
  const input =
    typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {};
  const role = typeof input["role"] === "string" ? input["role"] : "an agent";
  const model = typeof input["model"] === "string" ? input["model"] : undefined;
  return (
    <p className="flex items-center gap-2 text-[12.5px] text-fg-tertiary">
      <Workflow size={13} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 truncate">
        Asked to start <span className="font-medium text-fg-secondary">{role}</span>
        {model ? ` on ${model}` : ""}
      </span>
    </p>
  );
}

function AgentState({ state }: { state: ChildState }) {
  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-2xs ${state === "needsYou" ? "text-attention" : "text-fg-tertiary"}`}
    >
      {state === "running" ? (
        <span className="relative grid size-2 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-running/45" />
          <span className="size-1.5 rounded-full bg-running" />
        </span>
      ) : state === "needsYou" ? (
        <span className="mx-px size-1.5 rounded-full bg-attention" />
      ) : state === "failed" ? (
        <X size={11} strokeWidth={2.5} className="text-error" />
      ) : (
        <Check size={11} strokeWidth={2.5} className="text-success" />
      )}
      {{ running: "Working", needsYou: "Needs you", idle: "Done", failed: "Failed" }[state]}
    </span>
  );
}

export type PermissionAnswer = (decision: "allow" | "deny", scope: "once" | "session") => void;

export function PermissionCard({
  block,
  expired,
  from,
  keys,
  onAnswer,
}: {
  block: Block<"permission">;
  /** Who is asking, when it isn't the agent whose transcript this is. */
  from?: ReactNode;
  /** The agent stopped before anyone answered, so the request can't be answered any more. */
  expired: boolean;
  /** The buttons name the keys that answer this request (the one at the front of the tray). */
  keys?: boolean;
  onAnswer?: PermissionAnswer;
}) {
  if (block.resolution !== undefined || expired) {
    const { decision, scope } = block.resolution ?? {};
    return (
      <div className="flex items-center gap-2 text-xs text-fg-tertiary">
        {decision === "allow" ? (
          <Check size={12} strokeWidth={2.5} />
        ) : decision === "deny" ? (
          <X size={12} strokeWidth={2.5} />
        ) : (
          <Ban size={12} strokeWidth={2} />
        )}
        {decision === undefined
          ? "Not answered before the agent stopped"
          : decision === "allow"
            ? scope === "session"
              ? "Allowed for this chat"
              : "Allowed once"
            : "Denied"}
        <span className="text-fg-disabled">·</span>
        {block.summary}
      </div>
    );
  }

  return <PermissionPrompt request={block} from={from} keys={keys === true} onAnswer={onAnswer} />;
}

/** Why a turn ended early, which the conversation otherwise leaves unsaid. */
const stoppedNote = {
  interrupted: { text: "Stopped", Icon: Ban },
  steered: { text: "Steered by your message", Icon: CornerDownRight },
  maxTurns: { text: "Stopped at the turn limit", Icon: Ban },
} as const;

/**
 * The end of a response: a button that copies it, and what the turn cost. The transcript shows it
 * under the latest response, and under earlier ones while the pointer is over them.
 */
export function TurnFooter({ block, text }: { block: Block<"turnEnd">; text: string }) {
  const stopped =
    block.stopReason in stoppedNote ? stoppedNote[block.stopReason as keyof typeof stoppedNote] : undefined;
  // A turn stopped before the model answered reports nothing used, which isn't worth a line.
  const usage =
    block.usage !== undefined && block.usage.inputTokens + block.usage.outputTokens > 0
      ? block.usage
      : undefined;
  if (usage === undefined && text === "" && stopped === undefined) return null;
  return (
    <div className="flex min-h-6 items-center gap-2.5 text-2xs text-fg-tertiary tabular-nums">
      {text === "" ? null : <CopyButton text={text} label="Copy response" className="-ml-1.5" />}
      {stopped === undefined ? null : (
        <span className="flex items-center gap-1">
          <stopped.Icon size={11} strokeWidth={2} />
          {stopped.text}
        </span>
      )}
      {usage === undefined ? null : (
        <span className="flex items-center gap-2" title="Input counts cached tokens too">
          <span>{compactTokens(usage.inputTokens)} in</span>
          <span>{compactTokens(usage.outputTokens)} out</span>
          {usage.costUsd === undefined ? null : <span>{usd(usage.costUsd)}</span>}
        </span>
      )}
    </div>
  );
}
