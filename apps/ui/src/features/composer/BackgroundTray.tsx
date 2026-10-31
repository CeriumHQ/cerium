import { Button } from "@base-ui/react/button";
import type { BackgroundTask } from "@cerium/protocol";
import { Bot, ChevronDown, Radio, Square, SquareTerminal, Workflow } from "lucide-react";
import { useEffect, useState } from "react";

import { Reveal } from "../../components/Reveal.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useLingering } from "../../lib/motion.ts";
import { elapsed } from "../dictation/model.ts";

/** The backend version that stops background tasks (`StopBackgroundTask`). */
export const STOP_BACKGROUND_VERSION = 48;

/** One background task, with the agent that runs it when that isn't the lead. */
export interface BackgroundEntry {
  readonly agentId: string;
  /** The child's role; absent for the lead's own tasks. */
  readonly role?: string;
  readonly task: BackgroundTask;
}

export interface Background {
  readonly entries: ReadonlyArray<BackgroundEntry>;
  /** Stops a task the harness can stop; absent where the machine can't be asked. */
  readonly onStop?: ((agentId: string, taskId: string) => Promise<unknown>) | undefined;
}

const KIND_ICONS = { command: SquareTerminal, agent: Bot, monitor: Radio, other: Workflow } as const;

const iconButton =
  "grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-50";

/** A task's command line reads as code; a description in words, as text. */
const readsAsCommand = (task: BackgroundTask) => task.kind === "command" && task.command === undefined;

/**
 * The work the thread's agents left running in the background (a dev server, a long build, a watcher),
 * at the top of the message box, so it is never out of sight while it runs. A single task is its own
 * row; several fold under one line that opens to list them. Each can be stopped where its harness can.
 */
export function BackgroundTray({ background }: { readonly background: Background }) {
  const { entries, onStop } = background;
  const [open, setOpen] = useState(false);
  /** Tasks asked to stop, until they leave the list. */
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [rows, release] = useLingering(entries, (entry) => `${entry.agentId}:${entry.task.id}`);
  const several = entries.length > 1;

  useEffect(() => {
    if (entries.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [entries.length]);

  const stop = (entry: BackgroundEntry) => {
    if (onStop === undefined) return;
    const key = `${entry.agentId}:${entry.task.id}`;
    setStopping((current) => new Set(current).add(key));
    void onStop(entry.agentId, entry.task.id).then(
      () => undefined,
      // Refused: the button comes back.
      () =>
        setStopping((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        }),
    );
  };

  const row = (entry: BackgroundEntry) => {
    const { task } = entry;
    const Icon = KIND_ICONS[task.kind];
    const key = `${entry.agentId}:${task.id}`;
    return (
      <div className="flex h-8 items-center gap-2 rounded-lg pr-1 pl-2">
        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {entry.role ? <span className="shrink-0 text-caption text-fg-tertiary">{entry.role}</span> : null}
          <span
            className={`min-w-0 shrink truncate text-fg-primary ${
              readsAsCommand(task) ? "font-mono text-caption" : "text-body"
            }`}
          >
            {task.description || task.command || "Background task"}
          </span>
          {task.command ? (
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg-tertiary">
              {task.command}
            </span>
          ) : null}
        </span>
        {/* A lone task's row is the whole tray, so it says where it runs. */}
        <span className="shrink-0 text-caption text-fg-tertiary tabular-nums">
          {several ? "" : "In background"}
          {!several && task.startedAt !== undefined ? " · " : ""}
          {task.startedAt === undefined ? "" : elapsed(now - task.startedAt)}
        </span>
        {onStop && task.stoppable ? (
          <Tooltip label="Stop">
            <Button
              aria-label={`Stop ${task.description || "background task"}`}
              disabled={stopping.has(key)}
              onClick={() => stop(entry)}
              className={iconButton}
            >
              <Square size={10} strokeWidth={2.25} />
            </Button>
          </Tooltip>
        ) : null}
      </div>
    );
  };

  return (
    <Reveal>
      {entries.length === 0 ? null : (
        <div className="mx-2.5 mt-2.5 rounded-xl border border-line-subtle p-1">
          {several ? (
            <Button
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="flex h-8 w-full items-center gap-2 rounded-lg pr-2 pl-2 text-left transition-colors hover:bg-surface-hover"
            >
              <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-running" />
              <span className="shrink-0 text-body text-fg-primary">
                {entries.length} running in the background
              </span>
              {open ? (
                <span className="flex-1" />
              ) : (
                <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
                  {entries.map((entry) => entry.task.description).join(", ")}
                </span>
              )}
              <ChevronDown
                size={13}
                strokeWidth={1.75}
                className={`shrink-0 text-fg-tertiary transition-transform ${open ? "rotate-180" : ""}`}
              />
            </Button>
          ) : null}
          <Reveal>
            {several && !open ? null : (
              <ol>
                {rows.map(({ key, item, present }) => (
                  <li key={key}>
                    <Reveal onGone={() => release(key)}>{present ? row(item) : null}</Reveal>
                  </li>
                ))}
              </ol>
            )}
          </Reveal>
        </div>
      )}
    </Reveal>
  );
}
