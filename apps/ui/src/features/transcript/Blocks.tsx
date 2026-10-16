import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, Check, ChevronRight, CornerDownRight, ShieldQuestion, X } from "lucide-react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
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
    <div className="flex w-full gap-2.5 rounded-xl border border-line-subtle bg-surface-hover/50 px-3 py-2.5">
      <CornerDownRight size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-tertiary" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs text-fg-tertiary">
          <span className="font-medium text-fg-secondary">{from}</span> {verb}
        </span>
        <p className="text-[13px] leading-[1.55] text-fg-secondary select-text">{item.text}</p>
      </div>
    </div>
  );
}

export function Reasoning({ block }: { block: Block<"reasoning"> }) {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex items-center gap-1.5 text-[13px] text-fg-tertiary transition-colors hover:text-fg-secondary">
        <Brain size={14} strokeWidth={1.75} />
        {block.streaming ? "Thinking…" : "Thought"}
        <ChevronRight
          size={13}
          className="transition-transform duration-200 group-data-panel-open:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <p className="mt-2 border-l border-line-strong pl-3 text-[13px] leading-[1.6] text-fg-tertiary select-text">
          {block.text}
        </p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const accessLabel = { readOnly: "Read only", ask: "Asks to edit", acceptEdits: "Edits freely" } as const;

export function SpawnCard({ block, state }: { block: Block<"spawn">; state: "running" | "idle" | "failed" }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line-subtle bg-surface-raised px-3 py-2.5 shadow-raised">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-hover text-fg-primary">
        <ProviderLogo provider={block.provider} size={15} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-fg-primary">{block.role}</span>
        <span className="truncate text-xs text-fg-tertiary">
          {block.model} · {accessLabel[block.access]}
        </span>
      </div>
      <AgentState state={state} />
    </div>
  );
}

function AgentState({ state }: { state: "running" | "idle" | "failed" }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-tertiary">
      {state === "running" ? (
        <span className="relative grid size-2 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-accent/40" />
          <span className="size-1.5 rounded-full bg-accent" />
        </span>
      ) : state === "failed" ? (
        <X size={12} strokeWidth={2.5} />
      ) : (
        <Check size={12} strokeWidth={2.5} />
      )}
      {{ running: "Working", idle: "Done", failed: "Failed" }[state]}
    </span>
  );
}

export function PermissionCard({ block }: { block: Block<"permission"> }) {
  const command =
    typeof block.input === "object" && block.input !== null
      ? (block.input as Record<string, unknown>)["command"]
      : undefined;

  if (block.resolution !== undefined) {
    const { decision, scope } = block.resolution;
    return (
      <div className="flex items-center gap-2 text-xs text-fg-tertiary">
        {decision === "allow" ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
        {decision === "allow"
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
    <div className="flex flex-col gap-3 rounded-xl border border-line-strong bg-surface-raised p-3.5 shadow-raised">
      <div className="flex items-center gap-2 text-xs font-medium text-fg-secondary">
        <ShieldQuestion size={14} strokeWidth={1.75} />
        Approval needed
      </div>
      <p className="text-[14px] text-fg-primary">{block.summary}</p>
      {typeof command === "string" ? (
        <pre className="overflow-x-auto rounded-lg border border-line-subtle bg-surface-window px-3 py-2 font-mono text-[12.5px] text-fg-primary select-text">
          {command}
        </pre>
      ) : null}
      <div className="flex items-center gap-2">
        <Button className="h-8 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80">
          Allow once
        </Button>
        <Button className="h-8 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-fg-primary transition-colors hover:bg-surface-hover">
          Allow for session
        </Button>
        <Button className="ml-auto h-8 rounded-lg px-3 text-[13px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary">
          Deny
        </Button>
      </div>
    </div>
  );
}

const compact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : `${value}`;

export function TurnFooter({ block }: { block: Block<"turnEnd"> }) {
  if (block.usage === undefined) return null;
  const { inputTokens, outputTokens, costUsd } = block.usage;
  return (
    <div className="flex items-center gap-2 text-2xs text-fg-disabled tabular-nums">
      <span>{compact(inputTokens)} in</span>
      <span>{compact(outputTokens)} out</span>
      {costUsd === undefined ? null : <span>${costUsd.toFixed(2)}</span>}
    </div>
  );
}
