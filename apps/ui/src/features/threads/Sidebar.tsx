import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import type { ProviderId } from "@cerium/protocol";
import { ChevronRight, MessagesSquare, Search, Settings, SquarePen } from "lucide-react";

import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { shortAgo } from "../../lib/time.ts";
import { providerName, type ThreadSummary } from "./model.ts";

interface SidebarProps {
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly selectedId: string | undefined;
  readonly onSelect: (threadId: string) => void;
}

interface ThreadGroupData {
  readonly key: string;
  readonly label: string;
  readonly threads: ReadonlyArray<ThreadSummary>;
}

/** Work threads grouped by project folder, then chats; newest first within each group. */
const groupThreads = (threads: ReadonlyArray<ThreadSummary>): ReadonlyArray<ThreadGroupData> => {
  const byKey = new Map<string, ThreadGroupData>();
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = thread.mode === "chat" ? "chat" : `project:${thread.project ?? "Untitled"}`;
    const label = thread.mode === "chat" ? "Chats" : (thread.project ?? "Untitled");
    const group = byKey.get(key) ?? { key, label, threads: [] };
    byKey.set(key, { ...group, threads: [...group.threads, thread] });
  }
  return [...byKey.values()].sort((a, b) => Number(a.key === "chat") - Number(b.key === "chat"));
};

export function Sidebar({ threads, selectedId, onSelect }: SidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pb-2">
        <Button className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-line-subtle bg-surface-raised px-2.5 text-[13px] font-medium text-fg-primary shadow-raised transition-colors duration-150 hover:bg-surface-panel active:bg-surface-active">
          <SquarePen size={14} strokeWidth={1.75} className="text-fg-secondary" />
          New thread
          <kbd className="ml-auto font-sans text-2xs text-fg-tertiary">Ctrl N</kbd>
        </Button>
        <IconButton icon={Search} label="Search threads" shortcut="Ctrl K" />
      </div>

      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-3 px-2 pb-3" aria-label="Threads">
          {groupThreads(threads).map((group) => (
            <ThreadGroup key={group.key} group={group} selectedId={selectedId} onSelect={onSelect} />
          ))}
        </nav>
      </ScrollArea>

      <SidebarFooter />
    </div>
  );
}

function ThreadGroup({
  group,
  selectedId,
  onSelect,
}: {
  group: ThreadGroupData;
  selectedId: string | undefined;
  onSelect: (threadId: string) => void;
}) {
  return (
    <Collapsible.Root defaultOpen>
      <Collapsible.Trigger className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-fg-secondary/80 transition-colors hover:text-fg-primary">
        <ChevronRight
          size={12}
          strokeWidth={2}
          className="transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90"
        />
        {group.key === "chat" ? <MessagesSquare size={12} strokeWidth={2} /> : null}
        {group.label}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <ul className="flex flex-col gap-px pt-0.5">
          {group.threads.map((thread) => (
            <li key={thread.id}>
              <ThreadRow thread={thread} selected={thread.id === selectedId} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ThreadRow({
  thread,
  selected,
  onSelect,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onSelect: (threadId: string) => void;
}) {
  return (
    <Button
      onClick={() => onSelect(thread.id)}
      aria-current={selected ? "page" : undefined}
      className={`group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
        selected
          ? "bg-surface-selected text-fg-primary"
          : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
      }`}
    >
      <StatusIndicator status={thread.status} unread={thread.unread} />
      <span className={`min-w-0 flex-1 truncate ${thread.unread ? "font-medium text-fg-primary" : ""}`}>
        {thread.title}
      </span>
      {thread.providers.length > 1 && thread.status !== "idle" && thread.status !== "failed" ? (
        <ProviderStack providers={thread.providers} />
      ) : null}
      <span className="w-6 shrink-0 text-right text-2xs text-fg-tertiary tabular-nums">
        {shortAgo(thread.updatedAt)}
      </span>
    </Button>
  );
}

function StatusIndicator({ status, unread }: { status: ThreadSummary["status"]; unread: boolean }) {
  const label = {
    running: "Agents running",
    awaitingApproval: "Waiting for your approval",
    failed: "An agent failed",
    idle: unread ? "Unread" : "Idle",
  }[status];
  return (
    <span className="relative grid size-3 shrink-0 place-items-center">
      <span className="sr-only">{label}</span>
      {status === "running" ? (
        <>
          <span className="absolute size-2.5 animate-ping rounded-full bg-running/45" />
          <span className="size-1.5 rounded-full bg-running" />
        </>
      ) : status === "awaitingApproval" ? (
        <span className="size-1.5 rounded-full bg-attention shadow-[0_0_0_3px_color-mix(in_oklch,var(--status-attention)_28%,transparent)]" />
      ) : status === "failed" ? (
        <span className="size-1.5 rounded-full bg-error" />
      ) : unread ? (
        <span className="size-1.5 rounded-full bg-fg-secondary" />
      ) : null}
    </span>
  );
}

/** The logos of the harnesses an active multi-agent thread uses. */
function ProviderStack({ providers }: { providers: ReadonlyArray<ProviderId> }) {
  const distinct = [...new Set(providers)];
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 text-fg-tertiary"
      aria-label={`${providers.length} agents`}
    >
      {distinct.map((provider) => (
        <ProviderLogo key={provider} provider={provider} size={11} />
      ))}
    </span>
  );
}

const harnesses: ReadonlyArray<{ provider: ProviderId; state: "ready" | "loggedOut" | "missing" }> = [
  { provider: "claude", state: "ready" },
  { provider: "codex", state: "ready" },
  { provider: "muse", state: "loggedOut" },
  { provider: "cursor", state: "missing" },
];

const harnessState = { ready: "ready", loggedOut: "not logged in", missing: "not installed" };

function SidebarFooter() {
  return (
    <div className="flex items-center gap-1 border-t border-line-subtle px-2 pt-1.5">
      <IconButton icon={Settings} label="Settings" shortcut="Ctrl ," />
      <div className="ml-auto flex items-center gap-0.5" aria-label="Harnesses">
        {harnesses.map(({ provider, state }) => (
          <Tooltip key={provider} side="top" label={`${providerName[provider]}: ${harnessState[state]}`}>
            <Button
              aria-label={`${providerName[provider]} status`}
              className={`relative grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-hover ${
                state === "ready" ? "text-fg-secondary hover:text-fg-primary" : "text-fg-disabled"
              }`}
            >
              <ProviderLogo provider={provider} size={14} />
              {state === "loggedOut" ? (
                <span className="absolute right-1 bottom-1 size-1.5 rounded-full border border-surface-window bg-attention" />
              ) : null}
            </Button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
