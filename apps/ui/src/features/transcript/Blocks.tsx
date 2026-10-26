import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { promptName, type ModelSpeed, type ProviderId, type ReasoningEffort } from "@cerium/protocol";
import {
  ArrowRightLeft,
  Ban,
  Brain,
  Check,
  ChevronRight,
  CornerDownRight,
  FoldVertical,
  Pencil,
  RotateCcw,
  Route,
  Split,
  Workflow,
  X,
} from "lucide-react";
import { useContext, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { FileImageThumb } from "../../components/ImageThumb.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { compactTokens, usd } from "../../lib/format.ts";
import { AgentMenuArea, type AgentActions } from "../agents/AgentMenu.tsx";
import { PermissionPrompt } from "../agents/ApprovalParts.tsx";
import { accessLabel, type AgentSummary } from "../agents/model.ts";
import type { OutgoingMessage } from "../composer/Composer.tsx";
import { segmentsOf } from "../composer/draft.ts";
import { PromptDialog } from "../composer/PromptDialog.tsx";
import { newPrompt, usePrompts } from "../composer/prompts.ts";
import { takeLaunch } from "../composer/flight.ts";
import { useMessageBox } from "../composer/messageBox.ts";
import { effortLabel, speedLabel } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FileChip, WorkspaceFolder } from "./FileChip.tsx";
import { FoldedText } from "./FoldedText.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageEditor } from "./MessageEditor.tsx";
import { MessageMenuArea } from "./MessageMenu.tsx";
import type { RoutedDecision, TranscriptBlock } from "./model.ts";
import { attachmentImageKey } from "./tools.ts";

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
  const folder = useContext(WorkspaceFolder);
  const { savePrompt } = usePrompts();
  const [editing, setEditing] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const text = block.text.trim();
  const editable = onEdit !== undefined && block.delivered === true;
  // A message the agent never got began nothing to go back on.
  const restorable = onRestore !== undefined && block.delivered === true;
  // The message just sent from the box flies from there into this bubble as it first shows.
  const bubble = useRef<HTMLDivElement>(null);
  const land = useEffectEvent(() => {
    if (bubble.current) takeLaunch(bubble.current, block.text);
  });
  useLayoutEffect(() => land(), []);
  if (editing && editable) {
    return <MessageEditor block={block} onSend={onEdit} onCancel={() => setEditing(false)} />;
  }
  return (
    <>
      <MessageMenuArea
        text={text}
        onCopyToMessageBox={
          messageBox
            ? () =>
                messageBox.append({
                  segments: segmentsOf(block.text.trim(), block.mentions),
                  attachments: block.attachments,
                })
            : undefined
        }
        onSavePrompt={text === "" ? undefined : () => setPromptOpen(true)}
        onEdit={editable ? () => setEditing(true) : undefined}
        onRestore={restorable ? onRestore : undefined}
        className="group/user relative flex max-w-[85%] flex-col items-end gap-1.5"
      >
        {editable || restorable ? (
          <div className="absolute right-full bottom-0.5 mr-1 flex">
            {restorable ? (
              <Tooltip label="Restore to before this message">
                <Button
                  aria-label="Restore to before this message"
                  onClick={onRestore}
                  className={footButton}
                >
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
          <p className="flex max-w-full min-w-0 items-center gap-1.5 text-meta text-fg-tertiary">
            <Split size={12} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">
              Started from <span className="font-medium text-fg-secondary">{block.writtenIn}</span>
            </span>
          </p>
        )}
        {block.attachments.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {images.map((image, index) => (
              <FileImageThumb
                key={attachmentImageKey(block.id, index)}
                path={image.path}
                name={image.name}
                galleryKey={attachmentImageKey(block.id, index)}
                className="h-32 max-w-full min-w-16"
                fit="natural"
              />
            ))}
            {files.map((file) => (
              <span key={file.path} className="text-body">
                <FileChip path={file.path} folder={false} />
              </span>
            ))}
          </div>
        ) : null}
        {block.text.trim() === "" ? null : (
          <div
            ref={bubble}
            data-find={block.id}
            className="max-w-full rounded-2xl rounded-br-md border border-line-subtle bg-surface-raised px-4 py-2.5 shadow-raised select-text"
          >
            <FoldedText text={block.text}>
              <Markdown text={block.text} streaming={false} user={{ mentions: block.mentions }} />
            </FoldedText>
          </div>
        )}
      </MessageMenuArea>
      {promptOpen ? (
        <PromptDialog
          key={block.id}
          title="Save as prompt"
          submit="Save prompt"
          initial={{ name: promptName(text), text, ...(folder === undefined ? {} : { folder }) }}
          folders={folder === undefined ? [] : [folder]}
          onSave={(draft) => savePrompt(newPrompt(draft))}
          open
          onOpenChange={(open) => {
            if (!open) setPromptOpen(false);
          }}
        />
      ) : null}
    </>
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
      <MessageMenuArea text={text} className="flex gap-2 text-meta leading-[1.55]">
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
        <Collapsible.Trigger className="group flex w-full min-w-0 items-center gap-2 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-secondary">
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
    <output className="block text-meta">
      <span className="text-shimmer">Working…</span>
    </output>
  );
}

/**
 * Where the user switched the agent to another model, or just its effort or speed, or handed it to
 * another harness. A model's speed is said only past standard, where it costs more.
 */
export function ModelSwitch({
  provider,
  model,
  effort,
  speed,
  change,
}: {
  /** The harness it runs on from here. */
  provider: ProviderId;
  /** The model as people know it. */
  model: string;
  effort?: ReasoningEffort;
  speed?: ModelSpeed;
  change: "model" | "effort" | "speed" | "handoff";
}) {
  const settings = [
    ...(effort ? [effortLabel[effort]] : []),
    ...(speed && speed !== "standard" ? [speedLabel[speed]] : []),
  ]
    .map((label) => ` · ${label}`)
    .join("");
  return (
    <p className="flex items-center gap-2 text-meta text-fg-tertiary">
      {change === "handoff" ? (
        <ProviderLogo provider={provider} size={13} className="shrink-0 text-fg-secondary" />
      ) : (
        <ArrowRightLeft size={13} strokeWidth={1.75} className="shrink-0" />
      )}
      <span className="min-w-0 truncate">
        {change === "effort" ? (
          <>Effort set to {effort ? effortLabel[effort] : ""}</>
        ) : change === "speed" ? (
          <>Speed set to {speed ? speedLabel[speed] : ""}</>
        ) : change === "handoff" ? (
          <>
            Continued on{" "}
            <span className="font-medium text-fg-secondary">
              {providerName[provider]} · {model}
            </span>
            {settings}
          </>
        ) : (
          <>
            Switched to <span className="font-medium text-fg-secondary">{model}</span>
            {settings}
          </>
        )}
      </span>
    </p>
  );
}

/**
 * Where the harness compacted the conversation: whether on its own, its size before and after, and
 * unfolded, the summary it carries on with, as far as the harness says.
 */
export function Compaction({ block }: { block: Block<"compacted"> }) {
  const { tokensBefore, tokensAfter, summary } = block;
  const sizes =
    tokensBefore !== undefined && tokensAfter !== undefined
      ? `${compactTokens(tokensBefore)} → ${compactTokens(tokensAfter)}`
      : tokensBefore !== undefined
        ? `from ${compactTokens(tokensBefore)}`
        : undefined;
  const line = (
    <>
      <FoldVertical size={13} strokeWidth={1.75} className="shrink-0" />
      <span className="min-w-0 truncate">
        {block.trigger === "auto" ? "Compacted automatically" : "Compacted"}
        {sizes ? <span className="tabular-nums"> · {sizes}</span> : null}
      </span>
    </>
  );
  const text = summary?.trim();
  if (!text) return <p className="flex items-center gap-2 text-meta text-fg-tertiary">{line}</p>;
  return (
    <MessageMenuArea text={text}>
      <Collapsible.Root>
        <Collapsible.Trigger className="group flex max-w-full min-w-0 items-center gap-2 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-secondary">
          {line}
          <ChevronRight
            size={13}
            className="shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
          />
        </Collapsible.Trigger>
        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
          <div
            data-find={block.id}
            className="mt-2 ml-[5.5px] border-l border-line-strong pl-[14px] select-text"
          >
            <Markdown text={text} streaming={false} compact />
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </MessageMenuArea>
  );
}

/** Where an imported thread began: the harness its session came from, and whether its history came too. */
export function ImportedFrom({ block }: { block: Block<"imported"> }) {
  const harness = providerName[block.provider];
  return (
    <div className="flex flex-col gap-1 text-meta text-fg-tertiary">
      <p className="flex items-center gap-2">
        <ProviderLogo provider={block.provider} size={13} className="shrink-0 text-fg-secondary" />
        <span className="min-w-0 truncate">
          Imported from <span className="font-medium text-fg-secondary">{harness}</span>
        </span>
      </p>
      {block.unavailable === undefined ? null : (
        <p className="pl-5" title={block.unavailable.detail}>
          {harness} couldn't give this session's history. Your next message picks it up where it left off.
        </p>
      )}
    </div>
  );
}

export function Reasoning({ block }: { block: Block<"reasoning"> }) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex items-center gap-1.5 text-meta text-fg-tertiary transition-colors hover:text-fg-secondary">
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
      className="flex min-w-0 flex-[1_1_17rem] items-center gap-2 rounded-lg border border-line-subtle px-2.5 py-1.5 text-left text-meta transition-colors max-md:min-h-10 hover:border-line-strong hover:bg-surface-hover data-popup-open:border-line-strong data-popup-open:bg-surface-hover"
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
    <p className="flex items-center gap-2 text-meta text-fg-tertiary">
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
      className={`flex shrink-0 items-center gap-1 text-caption ${state === "needsYou" ? "text-attention" : "text-fg-tertiary"}`}
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
      <div className="flex items-center gap-2 text-meta text-fg-tertiary">
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

/** Why the effort router left the level where it was. */
const keptReason = (routed: RoutedDecision): string => {
  switch (routed.kept) {
    case "cache":
      return "Changing it would restart this model's prompt cache";
    case "unsure":
      return routed.confidence === undefined
        ? "The router wasn't sure enough"
        : `The router was only ${Math.round(routed.confidence * 100)}% sure`;
    case "timeout":
      return "The router didn't answer in time";
    default:
      return routed.detail ?? "The router couldn't decide";
  }
};

/** The level the effort router ran a turn at, with how it decided under the pointer. */
export function RoutedEffort({ routed }: { routed: RoutedDecision }) {
  const level = routed.effort === undefined ? "" : effortLabel[routed.effort];
  const facts = [
    routed.kept === undefined && routed.confidence !== undefined
      ? `${Math.round(routed.confidence * 100)}% sure`
      : undefined,
    routed.ms === undefined ? undefined : `${(routed.ms / 1000).toFixed(1)} s`,
    routed.costUsd === undefined ? undefined : `$${Number(routed.costUsd.toPrecision(2))}`,
  ].filter((fact) => fact !== undefined);
  return (
    <Tooltip
      side="top"
      label={
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">
            {routed.kept === undefined ? `Picked ${level}` : `Kept ${level}`}
          </span>
          {routed.kept === undefined ? null : <span className="text-fg-secondary">{keptReason(routed)}</span>}
          {facts.length > 0 ? (
            <span className="text-fg-tertiary tabular-nums">{facts.join(" · ")}</span>
          ) : null}
        </span>
      }
    >
      <Button className="-mx-1 flex h-5 items-center gap-1 rounded-md px-1 transition-colors hover:text-fg-secondary">
        <Route size={11} strokeWidth={2} />
        Auto · {level}
      </Button>
    </Tooltip>
  );
}

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
    <div className="flex min-h-6 items-center gap-2.5 text-caption text-fg-tertiary tabular-nums">
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
