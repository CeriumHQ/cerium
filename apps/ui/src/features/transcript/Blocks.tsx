import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Ban, Brain, Check, ChevronRight, CornerDownRight, ShieldQuestion, X } from "lucide-react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { compactTokens, usd } from "../../lib/format.ts";
import { fileEdits } from "./diff.ts";
import { EditDiff } from "./EditDiff.tsx";
import { Markdown } from "./Markdown.tsx";
import type { TranscriptBlock } from "./model.ts";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

export function UserMessage({ block }: { block: Block<"user"> }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-br-md border border-line-subtle bg-surface-raised px-4 py-2.5 shadow-raised select-text">
      <Markdown text={block.text} streaming={false} />
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
  return (
    <div className="flex gap-2 text-[12.5px] leading-[1.55]">
      <CornerDownRight size={13} strokeWidth={1.75} className="mt-[3px] shrink-0 text-fg-tertiary" />
      <p className="min-w-0 text-fg-tertiary select-text">
        <span className="font-medium text-fg-secondary">{from}</span> {verb}: {item.text}
      </p>
    </div>
  );
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

const accessLabel = { readOnly: "Read only", ask: "Asks to edit", acceptEdits: "Edits freely" } as const;

export function SpawnCard({ block, state }: { block: Block<"spawn">; state: "running" | "idle" | "failed" }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-subtle px-2.5 py-1.5 text-[12.5px]">
      <ProviderLogo provider={block.provider} size={13} className="text-fg-primary" />
      <span className="truncate font-medium text-fg-primary">{block.role}</span>
      <span className="min-w-0 flex-1 truncate text-fg-tertiary">
        {block.model} · {accessLabel[block.access]}
      </span>
      <AgentState state={state} />
    </div>
  );
}

function AgentState({ state }: { state: "running" | "idle" | "failed" }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-2xs text-fg-tertiary">
      {state === "running" ? (
        <span className="relative grid size-2 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-running/45" />
          <span className="size-1.5 rounded-full bg-running" />
        </span>
      ) : state === "failed" ? (
        <X size={11} strokeWidth={2.5} className="text-error" />
      ) : (
        <Check size={11} strokeWidth={2.5} className="text-success" />
      )}
      {{ running: "Working", idle: "Done", failed: "Failed" }[state]}
    </span>
  );
}

export type PermissionAnswer = (decision: "allow" | "deny", scope: "once" | "session") => void;

export function PermissionCard({
  block,
  expired,
  onAnswer,
}: {
  block: Block<"permission">;
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
