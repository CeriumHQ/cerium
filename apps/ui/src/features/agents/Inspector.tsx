import { Button } from "@base-ui/react/button";
import type { AccessMode } from "@cerium/protocol";
import {
  Check,
  CircleStop,
  Eye,
  FilePen,
  MessageSquareText,
  Pause,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { compactTokens, plainExcerpt, usd } from "../../lib/format.ts";
import { whenAgo } from "../../lib/time.ts";
import { effortLabel } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import { Markdown } from "../transcript/Markdown.tsx";
import { AgentMenuArea, StopAgentDialog, type AgentActions } from "./AgentMenu.tsx";
import {
  AgentApproval,
  AgentQuestion,
  LeadSpawnRequest,
  type AnswerApproval,
  type AnswerQuestion,
  type AnswerSpawn,
} from "./ApprovalTray.tsx";
import { Plan } from "./Plan.tsx";
import {
  accessLabel,
  agentMenuPlan,
  displayState,
  stateLabel,
  statusCounts,
  threadUsage,
  type AgentSummary,
} from "./model.ts";

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

interface InspectorProps {
  readonly agents: ReadonlyArray<AgentSummary>;
  /** The agent whose details show; the lead until another is picked. */
  readonly selectedId: string | undefined;
  readonly onSelect: (agentId: string) => void;
  readonly onClose: () => void;
  /** Moves to the composer, which messages the lead. */
  readonly onMessageLead?: () => void;
  readonly onInterrupt?: (agentId: string) => void;
  readonly onStop?: (agentId: string) => void;
  /** Answers a request a child is waiting on; the lead's own are answered in the transcript. */
  readonly onAnswerApproval?: AnswerApproval;
  /** Answers the lead's request to start an agent. */
  readonly onAnswerSpawn?: AnswerSpawn;
  /** Answers a child's questions; the lead's own are answered in the transcript. */
  readonly onAnswerQuestion?: AnswerQuestion;
}

const statusWords = {
  needsYou: (count: number) => (count === 1 ? "1 needs you" : `${count} need you`),
  running: (count: number) => `${count} working`,
  failed: (count: number) => `${count} failed`,
} as const;

const statusTone = { needsYou: "text-attention", running: "text-fg-tertiary", failed: "text-error" } as const;

/** The thread's agents: who is doing what, what they cost, and controls for each. */
export function Inspector({
  agents,
  selectedId,
  onSelect,
  onClose,
  onMessageLead,
  onInterrupt,
  onStop,
  onAnswerApproval,
  onAnswerSpawn,
  onAnswerQuestion,
}: InspectorProps) {
  const root = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLElement>(null);
  // Esc closes the panel while focus is inside it, unless a menu or dialog there used the key first.
  const onEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented && root.current?.contains(document.activeElement)) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const lead = agents.find((agent) => agent.parentId === undefined);
  if (lead === undefined) return null;
  const children = agents.filter((agent) => agent.parentId === lead.id);
  const selected = agents.find((agent) => agent.id === selectedId) ?? lead;
  const solo = children.length === 0;
  const actions: AgentActions = {
    ...(onMessageLead ? { onMessageLead } : {}),
    ...(onInterrupt ? { onInterrupt } : {}),
    ...(onStop ? { onStop } : {}),
  };

  // With many agents the details sit below the screen: bring them up once one is picked.
  const pick = (agentId: string) => {
    onSelect(agentId);
    requestAnimationFrame(() =>
      details.current?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      }),
    );
  };

  const counts = statusCounts(agents);

  return (
    <div ref={root} className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-12 max-md:pl-4">
        <span className="text-[13px] font-medium text-fg-primary max-md:text-[15px] max-md:font-semibold">
          {solo ? "Agent" : "Agents"}
        </span>
        {solo ? null : (
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs tabular-nums max-md:text-[13px]">
            {counts.map(({ state, count }) => (
              <span key={state} className={statusTone[state]}>
                {statusWords[state](count)}
              </span>
            ))}
          </span>
        )}
        <IconButton
          icon={X}
          label="Close"
          shortcut="Ctrl J"
          onClick={onClose}
          className="ml-auto max-md:size-10"
        />
      </header>

      <ScrollArea className="flex-1">
        {solo ? null : (
          <ul aria-label="Agents" className="flex flex-col gap-px p-1.5">
            <AgentRow agent={lead} selected={selected.id === lead.id} onSelect={pick} actions={actions} />
            {children.map((child, index) => (
              <AgentRow
                key={child.id}
                agent={child}
                selected={selected.id === child.id}
                onSelect={pick}
                actions={actions}
                branch={index === children.length - 1 ? "last" : "middle"}
              />
            ))}
          </ul>
        )}

        <AgentDetails
          ref={details}
          agent={selected}
          actions={actions}
          bare={solo}
          {...(selected.id === lead.id && onMessageLead ? { onMessage: onMessageLead } : {})}
          {...(selected.id !== lead.id && onAnswerApproval ? { onAnswerApproval } : {})}
          {...(selected.id === lead.id && onAnswerSpawn ? { onAnswerSpawn } : {})}
          {...(selected.id !== lead.id && onAnswerQuestion ? { onAnswerQuestion } : {})}
        />
        {solo ? null : <ThreadUsage agents={agents} />}
      </ScrollArea>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
  actions,
  branch,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: (agentId: string) => void;
  actions: AgentActions;
  /** Children draw a tree connector back to the lead. */
  branch?: "middle" | "last";
}) {
  return (
    <li>
      <AgentMenuArea agent={agent} actions={actions}>
        <Button
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(agent.id)}
          className={`relative flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-[12.5px] transition-colors data-popup-open:bg-surface-hover max-md:h-11 max-md:text-[14px] ${
            branch ? "pl-7" : "pl-2"
          } ${selected ? "bg-surface-selected text-fg-primary" : "text-fg-secondary hover:bg-surface-hover"}`}
        >
          {branch ? (
            <>
              <span
                className={`absolute left-[15px] w-px bg-line-strong ${branch === "last" ? "top-0 h-1/2" : "inset-y-0"}`}
              />
              <span className="absolute top-1/2 left-[15px] h-px w-2 bg-line-strong" />
            </>
          ) : null}
          <ProviderLogo provider={agent.provider} size={13} />
          <span className="shrink-0 font-medium text-fg-primary">
            {agent.parentId === undefined ? "Lead" : agent.role}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg-tertiary">{agent.model}</span>
          <StateBadge agent={agent} />
        </Button>
      </AgentMenuArea>
    </li>
  );
}

function StateBadge({ agent, plain = false }: { agent: AgentSummary; plain?: boolean }) {
  const state = displayState(agent);
  const finished = state === "idle" && agent.parentId !== undefined;
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 ${plain ? "text-[12.5px] max-md:text-[14px]" : "text-2xs max-md:text-xs"} ${
        state === "needsYou"
          ? "text-attention"
          : state === "failed"
            ? "text-error"
            : plain
              ? "text-fg-primary"
              : "text-fg-tertiary"
      }`}
    >
      {state === "running" ? (
        <span className="relative grid size-2 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-running/45" />
          <span className="size-1.5 rounded-full bg-running" />
        </span>
      ) : state === "needsYou" ? (
        <span className="size-1.5 rounded-full bg-attention shadow-[0_0_0_3px_color-mix(in_oklch,var(--status-attention)_28%,transparent)]" />
      ) : state === "failed" ? (
        <span className="size-1.5 rounded-full bg-error" />
      ) : finished ? (
        <Check size={11} strokeWidth={2.5} className="text-success" />
      ) : state === "queued" ? (
        <span className="size-1.5 rounded-full border border-fg-tertiary" />
      ) : state === "stopped" ? (
        <Square size={8} fill="currentColor" />
      ) : (
        <span className="size-1.5 rounded-full bg-fg-disabled" />
      )}
      {stateLabel(agent)}
    </span>
  );
}

const actionButton =
  "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors max-md:h-10 max-md:px-3.5 max-md:text-[14px]";

function AgentDetails({
  ref,
  agent,
  actions,
  bare,
  onMessage,
  onAnswerApproval,
  onAnswerSpawn,
  onAnswerQuestion,
}: {
  ref: React.Ref<HTMLElement>;
  agent: AgentSummary;
  actions: AgentActions;
  /** The only agent: no list names it or its state, so the details do. */
  bare: boolean;
  /** Absent where Cerium can't message this agent from here yet. */
  onMessage?: () => void;
  onAnswerApproval?: AnswerApproval;
  onAnswerSpawn?: AnswerSpawn;
  onAnswerQuestion?: AnswerQuestion;
}) {
  const AccessIcon = accessIcon[agent.access];
  const [confirmingStop, setConfirmingStop] = useState(false);
  const failed = agent.state === "failed";
  const ended = failed || agent.state === "stopped";
  const plan = agentMenuPlan(agent, { card: false, canMessage: onMessage !== undefined });
  const { inputTokens, outputTokens, costUsd } = agent.usage;
  const reported = inputTokens + outputTokens > 0;
  // The lead's own requests are answered in the conversation, so the panel points there.
  const asksInConversation =
    agent.parentId === undefined && (agent.approvals.length > 0 || agent.questions.length > 0);
  return (
    <section
      ref={ref}
      className="flex flex-col gap-3 border-t border-line-subtle px-3 py-3 max-md:px-4"
      aria-label="Agent details"
    >
      <dl className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] max-md:text-[14px]">
        {bare ? (
          <>
            <dt className="text-fg-tertiary">Status</dt>
            <dd className="flex min-w-0 items-center">
              <StateBadge agent={agent} plain />
            </dd>
          </>
        ) : null}
        <dt className="text-fg-tertiary">Model</dt>
        <dd className="truncate text-fg-primary" title={agent.model}>
          {agent.model}
          {agent.effort ? <span className="text-fg-tertiary"> · {effortLabel[agent.effort]}</span> : null}
        </dd>
        <dt className="text-fg-tertiary">Access</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-fg-primary">
          <AccessIcon size={12} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          {accessLabel[agent.access]}
        </dd>
        <dt className="text-fg-tertiary">Usage</dt>
        {/* Usage arrives when a turn ends; until then there is nothing to count. Not every harness reports a cost. */}
        <dd className="truncate text-fg-primary tabular-nums">
          {reported ? (
            <>
              {compactTokens(inputTokens)} in · {compactTokens(outputTokens)} out
              {costUsd !== undefined ? ` · ${usd(costUsd)}` : ""}
            </>
          ) : (
            <span className="text-fg-tertiary">None yet</span>
          )}
        </dd>
        <dt className="text-fg-tertiary">Started</dt>
        <dd className="text-fg-primary" title={new Date(agent.startedAt).toLocaleString()}>
          {whenAgo(agent.startedAt)}
        </dd>
      </dl>

      <Plan
        key={agent.id}
        items={agent.todos}
        working={agent.state === "running"}
        explanation={agent.todosNote}
      />

      {onAnswerApproval && agent.approvals.length > 0 ? (
        <AgentApproval agent={agent} named={false} onAnswer={onAnswerApproval} />
      ) : null}
      {onAnswerSpawn && agent.spawns.length > 0 ? (
        <LeadSpawnRequest lead={agent} onAnswer={onAnswerSpawn} />
      ) : null}
      {onAnswerQuestion && agent.questions.length > 0 ? (
        <AgentQuestion agent={agent} onAnswer={onAnswerQuestion} />
      ) : null}
      {asksInConversation ? (
        <p className="flex items-center gap-1.5 text-[12.5px] text-attention max-md:text-[14px]">
          <ShieldQuestion size={13} strokeWidth={1.75} />
          Waiting for you in the conversation
        </p>
      ) : null}

      {failed && agent.error ? (
        <Quote label="Error" tone="error">
          {agent.error}
        </Quote>
      ) : null}
      {agent.lastMessage ? (
        <Quote label="Latest message" markdown={agent.lastMessage}>
          {plainExcerpt(agent.lastMessage)}
        </Quote>
      ) : null}

      {/* An ended lead resumes from the message box; an ended child can't restart. Nothing to do here. */}
      {ended ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {plan.message ? (
            <Button
              onClick={() => actions.onMessageLead?.()}
              className={`${actionButton} border border-line-strong text-fg-primary hover:bg-surface-hover`}
            >
              <MessageSquareText size={13} strokeWidth={1.75} />
              Message
            </Button>
          ) : null}
          {plan.interrupt === "enabled" ? (
            <Button
              onClick={() => actions.onInterrupt?.(agent.id)}
              className={`${actionButton} border border-line-strong text-fg-primary hover:bg-surface-hover`}
            >
              <Pause size={13} strokeWidth={1.75} />
              Interrupt
            </Button>
          ) : null}
          {plan.stop ? (
            <Button
              onClick={() => setConfirmingStop(true)}
              className={`${actionButton} ml-auto text-fg-secondary hover:bg-error/10 hover:text-error`}
            >
              <CircleStop size={13} strokeWidth={1.75} />
              Stop
            </Button>
          ) : null}
          <StopAgentDialog
            agent={agent}
            open={confirmingStop}
            onOpenChange={setConfirmingStop}
            onConfirm={() => actions.onStop?.(agent.id)}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Words of the agent's, four lines of them; what doesn't fit opens in place. A message folds back
 * to plain text, an expanded one reads as the agent wrote it.
 */
function Quote({
  label,
  tone = "default",
  markdown,
  children,
}: {
  label: string;
  tone?: "default" | "error";
  /** The message as written, shown in full once expanded. */
  markdown?: string;
  children: string;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const color = tone === "error" ? "text-error" : "text-fg-secondary";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs text-fg-tertiary max-md:text-xs">{label}</span>
      <div
        className={`border-l pl-2.5 ${tone === "error" ? "border-error/40" : "border-line-strong"} ${color}`}
      >
        {open ? (
          markdown !== undefined ? (
            <Markdown text={markdown} streaming={false} compact />
          ) : (
            <p className="text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap select-text max-md:text-[14px]">
              {children}
            </p>
          )
        ) : (
          <p
            ref={(element) => {
              if (element) setClipped(element.scrollHeight > element.clientHeight + 1);
            }}
            className="line-clamp-4 text-[12.5px] leading-[1.55] break-words select-text max-md:text-[14px]"
          >
            {children}
          </p>
        )}
        {clipped || open ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-1 -ml-0.5 rounded px-0.5 text-xs text-fg-tertiary transition-colors hover:text-fg-primary max-md:py-1.5 max-md:text-[13px]"
          >
            {open ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Usage across the thread: the cost at a glance, each provider's share when asked for. */
function ThreadUsage({ agents }: { agents: ReadonlyArray<AgentSummary> }) {
  const { providers, total, partial } = threadUsage(agents);
  if (providers.length === 0) return null;
  return (
    <section className="border-t border-line-subtle px-3 py-2 max-md:px-4" aria-label="Thread usage">
      <Disclosure
        summary="Thread usage"
        hint={total > 0 ? `${usd(total)}${partial ? "+" : ""}` : "No cost reported"}
      >
        <div className="flex flex-col gap-1.5">
          {providers.map(({ provider, inputTokens, outputTokens, costUsd }) => (
            <div key={provider} className="flex items-center gap-2 text-[12.5px] max-md:text-[14px]">
              <ProviderLogo provider={provider} size={12} />
              <span className="text-fg-secondary">{providerName[provider]}</span>
              <span className="ml-auto text-fg-tertiary tabular-nums">
                {compactTokens(inputTokens)} in · {compactTokens(outputTokens)} out
              </span>
              <span className="w-12 text-right text-fg-secondary tabular-nums">
                {costUsd === undefined ? <span className="text-fg-tertiary">–</span> : usd(costUsd)}
              </span>
            </div>
          ))}
          {providers.length > 1 ? (
            <div className="flex items-center gap-2 border-t border-line-subtle pt-1.5 text-[12.5px] max-md:text-[14px]">
              <span className="text-fg-primary">Total</span>
              <span className="ml-auto text-fg-tertiary tabular-nums">
                {compactTokens(providers.reduce((sum, each) => sum + each.inputTokens, 0))} in ·{" "}
                {compactTokens(providers.reduce((sum, each) => sum + each.outputTokens, 0))} out
              </span>
              <span className="w-12 text-right text-fg-primary tabular-nums">
                {total > 0 ? usd(total) : <span className="text-fg-tertiary">–</span>}
              </span>
            </div>
          ) : null}
          {partial ? (
            <p className="text-2xs text-fg-tertiary max-md:text-xs">
              A dash means that harness reports no cost, so the total leaves it out.
            </p>
          ) : null}
        </div>
      </Disclosure>
    </section>
  );
}
