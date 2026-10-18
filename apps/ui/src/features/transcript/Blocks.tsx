import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Ban, Brain, Check, ChevronRight, CornerDownRight, ShieldQuestion, X } from "lucide-react";
import type { ReactNode } from "react";

import { FileImageThumb } from "../../components/ImageThumb.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { compactTokens, usd } from "../../lib/format.ts";
import { AgentMenuArea, type AgentActions } from "../agents/AgentMenu.tsx";
import type { AgentSummary } from "../agents/model.ts";
import { segmentsOf } from "../composer/draft.ts";
import { useMessageBox } from "../composer/messageBox.ts";
import { fileEdits } from "./diff.ts";
import { EditDiff } from "./EditDiff.tsx";
import { FileChip } from "./FileChip.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageMenuArea } from "./MessageMenu.tsx";
import type { TranscriptBlock } from "./model.ts";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

export function UserMessage({ block }: { block: Block<"user"> }) {
  const images = block.attachments.filter((attachment) => attachment.mediaType.startsWith("image/"));
  const files = block.attachments.filter((attachment) => !attachment.mediaType.startsWith("image/"));
  const messageBox = useMessageBox();
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
      className="flex max-w-[85%] flex-col items-end gap-1.5"
    >
      {block.attachments.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((image) => (
            <FileImageThumb
              key={image.path}
              path={image.path}
              name={image.name}
              className="h-28 max-w-60 min-w-16"
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
        <div className="rounded-2xl rounded-br-md border border-line-subtle bg-surface-raised px-4 py-2.5 shadow-raised select-text">
          <Markdown text={block.text} streaming={false} user={{ mentions: block.mentions }} />
        </div>
      )}
    </MessageMenuArea>
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
        <p className="mt-1.5 border-l border-line-strong pl-3 text-[12.5px] leading-[1.6] text-fg-tertiary select-text">
          {block.text}
        </p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const accessLabel = {
  readOnly: "Read only",
  ask: "Asks to edit",
  acceptEdits: "Edits freely",
  fullAccess: "Full access",
} as const;

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
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-subtle px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:border-line-strong hover:bg-surface-hover data-popup-open:border-line-strong data-popup-open:bg-surface-hover"
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
  onAnswer,
}: {
  block: Block<"permission">;
  /** Who is asking, when it isn't the agent whose transcript this is. */
  from?: ReactNode;
  /** The agent stopped before anyone answered, so the request can't be answered any more. */
  expired: boolean;
  onAnswer?: PermissionAnswer;
}) {
  const command =
    typeof block.input === "object" && block.input !== null
      ? (block.input as Record<string, unknown>)["command"]
      : undefined;
  const edits = fileEdits(block.input);

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
              ? "Allowed for this session"
              : "Allowed once"
            : "Denied"}
        <span className="text-fg-disabled">·</span>
        {block.summary}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-attention/35 bg-surface-raised p-3 shadow-raised">
      {from}
      <div className="flex items-center gap-1.5 text-[12.5px] text-fg-secondary">
        <ShieldQuestion size={13} strokeWidth={1.75} className="text-attention" />
        <span className="font-medium text-fg-primary">{block.summary}</span>
        <span className="text-attention">needs approval</span>
      </div>
      {/* What the agent wants to do, so the answer is an informed one. */}
      {typeof command === "string" ? (
        <pre className="overflow-x-auto rounded-md border border-line-subtle bg-surface-window px-2.5 py-1.5 font-mono text-[12px] text-fg-primary select-text">
          {command}
        </pre>
      ) : edits.length > 0 ? (
        <EditDiff edits={edits} />
      ) : null}
      <div className="flex items-center gap-1.5">
        <Button
          onClick={() => onAnswer?.("allow", "once")}
          className="h-7 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
        >
          Allow once
        </Button>
        <Button
          onClick={() => onAnswer?.("allow", "session")}
          className="h-7 rounded-md border border-line-strong px-2.5 text-[12.5px] font-medium text-fg-primary transition-colors hover:bg-surface-hover"
        >
          Allow for session
        </Button>
        <Button
          onClick={() => onAnswer?.("deny", "once")}
          className="ml-auto h-7 rounded-md px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

export function TurnFooter({ block }: { block: Block<"turnEnd"> }) {
  if (block.usage === undefined) return null;
  const { inputTokens, outputTokens, costUsd } = block.usage;
  return (
    <div className="flex items-center gap-2 text-2xs text-fg-disabled tabular-nums">
      <span>{compactTokens(inputTokens)} in</span>
      <span>{compactTokens(outputTokens)} out</span>
      {costUsd === undefined ? null : <span>{usd(costUsd)}</span>}
    </div>
  );
}
