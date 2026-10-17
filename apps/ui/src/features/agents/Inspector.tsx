import { Button } from "@base-ui/react/button";
import type { AccessMode, ProviderId } from "@cerium/protocol";
import {
  Check,
  CircleStop,
  Ellipsis,
  Eye,
  FilePen,
  MessageSquareText,
  PanelRightOpen,
  Pause,
  ShieldQuestion,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { MenuItem, MenuPopup, MenuRoot, MenuSeparator, MenuTrigger } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { shortAgo } from "../../lib/time.ts";
import { effortLabel } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import { accessLabel, displayState, displayStateLabel, type AgentSummary } from "./model.ts";

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
};

const compact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : `${value}`;

interface InspectorProps {
  readonly agents: ReadonlyArray<AgentSummary>;
  readonly onClose: () => void;
  readonly onInterrupt?: (agentId: string) => void;
  readonly onStop?: (agentId: string) => void;
}

/** The thread's agents: who is doing what, what they cost, and controls for each. */
export function Inspector({ agents, onClose, onInterrupt, onStop }: InspectorProps) {
  const lead = agents.find((agent) => agent.parentId === undefined);
  const [selectedId, setSelectedId] = useState(lead?.id);
  if (lead === undefined) return null;
  const children = agents.filter((agent) => agent.parentId === lead.id);
  const selected = agents.find((agent) => agent.id === selectedId) ?? lead;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line-subtle pr-1.5 pl-3">
        <span className="text-[13px] font-medium text-fg-primary">Agents</span>
        <span className="text-xs text-fg-tertiary tabular-nums">{agents.length}</span>
        <IconButton icon={X} label="Close" shortcut="Ctrl J" onClick={onClose} className="ml-auto" />
      </header>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-px p-1.5" role="tree" aria-label="Agents">
          <AgentRow agent={lead} selected={selected.id === lead.id} onSelect={setSelectedId} />
          {children.map((child, index) => (
            <AgentRow
              key={child.id}
              agent={child}
              selected={selected.id === child.id}
              onSelect={setSelectedId}
              branch={index === children.length - 1 ? "last" : "middle"}
            />
          ))}
        </div>

        <AgentDetails
          agent={selected}
          onInterrupt={() => onInterrupt?.(selected.id)}
          onStop={() => onStop?.(selected.id)}
        />
        <UsageSummary agents={agents} />
      </ScrollArea>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  onSelect,
  branch,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: (agentId: string) => void;
  /** Children draw a tree connector back to the lead. */
  branch?: "middle" | "last";
}) {
  return (
    <Button
      role="treeitem"
      aria-selected={selected}
      onClick={() => onSelect(agent.id)}
      className={`relative flex h-8 items-center gap-2 rounded-md pr-2 text-left text-[12.5px] transition-colors ${
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
  );
}

function StateBadge({ agent }: { agent: AgentSummary }) {
  const state = displayState(agent);
  // A child that went idle has delivered its result: that reads as done.
  const finished = state === "idle" && agent.parentId !== undefined;
  const label = finished ? "Done" : displayStateLabel[state];
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 text-2xs ${
        state === "needsYou" ? "text-attention" : state === "failed" ? "text-error" : "text-fg-tertiary"
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
      {label}
    </span>
  );
}

function AgentDetails({
  agent,
  onInterrupt,
  onStop,
}: {
  agent: AgentSummary;
  onInterrupt: () => void;
  onStop: () => void;
}) {
  const AccessIcon = accessIcon[agent.access];
  const { inputTokens, outputTokens, costUsd } = agent.usage;
  return (
    <section className="flex flex-col gap-3 border-t border-line-subtle px-3 py-3" aria-label="Agent details">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[12.5px]">
        <Detail label="Model">
          {agent.model}
          {agent.effort ? <span className="text-fg-tertiary"> · {effortLabel[agent.effort]}</span> : null}
        </Detail>
        <Detail label="Access">
          <AccessIcon size={12} strokeWidth={1.75} className="text-fg-tertiary" />
          {accessLabel[agent.access]}
        </Detail>
        <Detail label="Tokens">
          {compact(inputTokens)} in · {compact(outputTokens)} out
        </Detail>
        <Detail label="Cost">{costUsd === undefined ? "Not reported" : `$${costUsd.toFixed(2)}`}</Detail>
        <Detail label="Started">{shortAgo(agent.startedAt)} ago</Detail>
      </dl>

      {agent.lastMessage ? (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-fg-tertiary">Latest message</span>
          <p className="line-clamp-4 border-l border-line-strong pl-2.5 text-[12.5px] leading-[1.55] text-fg-secondary select-text">
            {agent.lastMessage}
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button className="flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12.5px] text-fg-primary transition-colors hover:bg-surface-hover">
          <PanelRightOpen size={13} strokeWidth={1.75} />
          Open
        </Button>
        <Button className="flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[12.5px] text-fg-primary transition-colors hover:bg-surface-hover">
          <MessageSquareText size={13} strokeWidth={1.75} />
          Message
        </Button>
        <MenuRoot>
          <MenuTrigger>
            <Button
              aria-label="More actions"
              className="ml-auto grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-secondary data-popup-open:bg-surface-active"
            >
              <Ellipsis size={15} />
            </Button>
          </MenuTrigger>
          <MenuPopup>
            <MenuItem icon={Pause} onClick={onInterrupt}>
              Interrupt turn
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={CircleStop} tone="danger" onClick={onStop}>
              Stop agent
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs text-fg-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 truncate text-fg-primary">{children}</dd>
    </div>
  );
}

/** Usage across the thread, per provider. */
function UsageSummary({ agents }: { agents: ReadonlyArray<AgentSummary> }) {
  const byProvider = new Map<ProviderId, { input: number; output: number; cost: number }>();
  for (const { provider, usage } of agents) {
    const total = byProvider.get(provider) ?? { input: 0, output: 0, cost: 0 };
    byProvider.set(provider, {
      input: total.input + usage.inputTokens,
      output: total.output + usage.outputTokens,
      cost: total.cost + (usage.costUsd ?? 0),
    });
  }
  const totalCost = [...byProvider.values()].reduce((sum, { cost }) => sum + cost, 0);
  return (
    <section
      className="flex flex-col gap-1.5 border-t border-line-subtle px-3 py-3"
      aria-label="Thread usage"
    >
      <div className="flex items-baseline justify-between text-2xs text-fg-tertiary">
        <span>Thread usage</span>
        <span className="text-[12.5px] text-fg-primary tabular-nums">${totalCost.toFixed(2)}</span>
      </div>
      {[...byProvider].map(([provider, { input, output, cost }]) => (
        <div key={provider} className="flex items-center gap-2 text-[12.5px]">
          <ProviderLogo provider={provider} size={12} />
          <span className="text-fg-secondary">{providerName[provider]}</span>
          <span className="ml-auto text-fg-tertiary tabular-nums">
            {compact(input)} · {compact(output)}
          </span>
          <span className="w-10 text-right text-fg-secondary tabular-nums">${cost.toFixed(2)}</span>
        </div>
      ))}
    </section>
  );
}
