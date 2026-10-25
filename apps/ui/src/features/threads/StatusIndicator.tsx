import type { ProviderId } from "@cerium/protocol";
import { useState, type CSSProperties } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { providerName, type ThreadSummary } from "./model.ts";
import { ProjectBadge } from "./ProjectBadge.tsx";

const statusLabel = (status: ThreadSummary["status"], unread: boolean) =>
  ({
    running: "Agents running",
    awaitingApproval: "Waiting for your approval",
    failed: "An agent failed",
    idle: unread ? "Unread" : "Idle",
  })[status];

const statusTone = {
  running: "bg-running",
  awaitingApproval: "bg-attention",
  failed: "bg-error",
  idle: "bg-fg-primary",
};

/**
 * Pixel sizes of a mark: its tile, the harness logo on its lower corner and the status dot on its
 * upper one, how far each pokes past the tile, and the clear ring cut around them.
 */
const markSizes = {
  /** Inline with 12.5px tab and header text. */
  small: { tile: 14, logo: 8, logoOut: 2.5, dot: 5, dotOut: 1.5, gap: 1.25 },
  medium: { tile: 18, logo: 10, logoOut: 3, dot: 6, dotOut: 2, gap: 1.5 },
};

/** A hole in the tile around a piece of `size` whose outer edges sit `out` past the corner. */
const hole = (size: number, out: number, gap: number, y: "top" | "bottom") => {
  const inset = size / 2 - out;
  const radius = size / 2 + gap;
  const at =
    y === "top" ? `calc(100% - ${inset}px) ${inset}px` : `calc(100% - ${inset}px) calc(100% - ${inset}px)`;
  return `radial-gradient(circle ${radius}px at ${at}, transparent ${radius - 0.5}px, #000 ${radius}px)`;
};

/**
 * What a thread is at a glance: its project's icon (or, for a chat, its harness's logo), the harness
 * running it on the tile's lower corner and its status on the upper one. The tile is cut away around
 * both, so they read on any background; a resting, read thread shows no dot.
 */
export function ThreadMark({
  thread,
  unread,
  size = "medium",
  count,
}: {
  thread: Pick<ThreadSummary, "status" | "project" | "folder" | "providers" | "elsewhere">;
  unread: boolean;
  size?: keyof typeof markSizes;
  /** A multi-agent run's mark: how many threads it holds, on the corner in place of a harness. */
  count?: number;
}) {
  const { tile, logo, logoOut, dot, dotOut, gap } = markSizes[size];
  const { status } = thread;
  const provider = thread.providers[0];
  const project = thread.folder !== undefined && thread.project !== undefined;
  const signal = status !== "idle" || unread;
  const changed = useChanged(`${status}:${unread}`);
  const corner = (project && provider !== undefined) || count !== undefined;
  const holes = [
    ...(corner ? [hole(logo, logoOut, gap, "bottom")] : []),
    ...(signal ? [hole(dot, dotOut, gap, "top")] : []),
  ];
  const cut: CSSProperties =
    holes.length === 0 ? {} : { maskImage: holes.join(", "), maskComposite: "intersect" };
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: tile, height: tile }}>
      <span className="grid size-full place-items-center" style={cut}>
        {project ? (
          <ProjectBadge
            folder={thread.folder!}
            name={thread.project!}
            size={size}
            lookup={thread.elsewhere === undefined}
          />
        ) : provider !== undefined ? (
          <span className="text-fg-secondary">
            <ProviderLogo provider={provider} size={tile - 2} />
          </span>
        ) : (
          <span className="size-full rounded-[5px] border border-line-subtle bg-surface-raised" />
        )}
      </span>
      {count !== undefined ? (
        <span
          className="absolute grid place-items-center rounded-full bg-fg-secondary text-[7.5px] leading-none font-bold text-background tabular-nums"
          style={{ right: -logoOut, bottom: -logoOut, width: logo, height: logo }}
        >
          <span className="sr-only">{count} threads, </span>
          {count}
        </span>
      ) : corner ? (
        <span
          className="absolute grid place-items-center text-fg-secondary"
          style={{ right: -logoOut, bottom: -logoOut, width: logo, height: logo }}
        >
          <span className="sr-only">{providerName[provider!]}</span>
          <ProviderLogo provider={provider!} size={logo} />
        </span>
      ) : null}
      {signal ? (
        <span
          className="absolute grid place-items-center"
          style={{ right: -dotOut, top: -dotOut, width: dot, height: dot }}
        >
          <span className="sr-only">{statusLabel(status, unread)}</span>
          {status === "running" ? (
            <span className="absolute size-full animate-ping rounded-full bg-running/50" />
          ) : null}
          {/* A new status lands: the dot pops in at its colour. What the mark first showed is just there. */}
          <span
            key={`${status}:${unread}`}
            className={`size-full rounded-full ${statusTone[status]} ${
              changed ? "transition-[scale] duration-300 ease-pop starting:scale-0" : ""
            }`}
          />
        </span>
      ) : null}
    </span>
  );
}

/** Whether the value has changed since the component mounted. */
function useChanged(value: string): boolean {
  const [first] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && value !== first) setChanged(true);
  return changed;
}

/** The logos of the harnesses a thread's agents use. */
export function ProviderStack({ providers }: { providers: ReadonlyArray<ProviderId> }) {
  const distinct = [...new Set(providers)];
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-fg-tertiary">
      <span className="sr-only">
        {providers.length === 1 ? providerName[providers[0]!] : `${providers.length} agents`}
      </span>
      {distinct.map((provider) => (
        <ProviderLogo key={provider} provider={provider} size={11} />
      ))}
    </span>
  );
}
