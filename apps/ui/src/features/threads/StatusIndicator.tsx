import type { ProviderId } from "@cerium/protocol";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import type { ThreadSummary } from "./model.ts";

const statusLabel = (status: ThreadSummary["status"], unread: boolean) =>
  ({
    running: "Agents running",
    awaitingApproval: "Waiting for your approval",
    failed: "An agent failed",
    idle: unread ? "Unread" : "Idle",
  })[status];

export function StatusIndicator({ status, unread }: { status: ThreadSummary["status"]; unread: boolean }) {
  return (
    <span className="relative grid size-3 shrink-0 place-items-center">
      <span className="sr-only">{statusLabel(status, unread)}</span>
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

/** A thread's status as a small dot on the corner of its project badge; nothing while it rests, read. */
export function CornerStatus({ status, unread }: { status: ThreadSummary["status"]; unread: boolean }) {
  if (status === "idle" && !unread) return null;
  const tone = {
    running: "bg-running",
    awaitingApproval: "bg-attention",
    failed: "bg-error",
    idle: "bg-fg-secondary",
  }[status];
  return (
    <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-surface-overlay">
      <span className="sr-only">{statusLabel(status, unread)}</span>
      {status === "running" ? (
        <span className="absolute size-2.5 animate-ping rounded-full bg-running/40" />
      ) : null}
      <span className={`size-1.5 rounded-full ${tone}`} />
    </span>
  );
}

/** The logos of the harnesses an active multi-agent thread uses. */
export function ProviderStack({ providers }: { providers: ReadonlyArray<ProviderId> }) {
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
