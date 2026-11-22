import { Button } from "@base-ui/react/button";
import { CornerDownRight, Paperclip, Pencil, RefreshCw, RotateCcw, Smartphone, X } from "lucide-react";
import { useState } from "react";

import { Reveal } from "../../components/Reveal.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useLingering } from "../../lib/motion.ts";
import { useShortcut } from "../../lib/shortcuts.ts";
import { useKeyboardOpen } from "../../web/viewport.ts";
import type { UserBlock } from "../transcript/model.ts";
import type { Outbox, OutboxStatus } from "./outbox.ts";

/**
 * A message waiting in the box: the machine's, or one kept on this device until the machine can
 * take it, which carries where it is on its way.
 */
export type QueuedMessage = UserBlock & {
  readonly status?: OutboxStatus | undefined;
  /** Why it didn't go, written for the user. */
  readonly error?: string | undefined;
};

/** The user's messages waiting for the lead, as the message box shows them. */
export interface Queue {
  readonly messages: ReadonlyArray<QueuedMessage>;
  /** The lead ended: they go with the user's next message rather than at the agent's next step. */
  readonly ended: boolean;
  /** Interrupts the turn to hand them over now; absent where they can only wait. */
  readonly onSteer?: (() => void) | undefined;
  /** Takes one back; resolves false when the agent took it first. Absent where the machine can't. */
  readonly onWithdraw?: ((messageId: string) => Promise<boolean>) | undefined;
  /** The thread's machine can't be reached: the messages wait on this device until it can. */
  readonly held?: "offline" | "reconnecting" | undefined;
  /** The name of the machine they wait for. */
  readonly machine?: string | undefined;
  /** Tries the machine again now. */
  readonly onRetryNow?: (() => void) | undefined;
  /** Puts a message kept here that failed back in line. */
  readonly onRetryItem?: ((id: string) => void) | undefined;
  /** Gives a message kept here back to the draft; false when it's already on its way. */
  readonly onRestore?: ((id: string) => boolean) | undefined;
  /** Drops a message kept here unsent. */
  readonly onRemove?: ((id: string) => void) | undefined;
}

const emptyQueue: Queue = { messages: [], ended: false };

/** Whether a message waits on this device rather than with the machine. */
const isLocal = (message: QueuedMessage) => message.status !== undefined;

/** The outbox's messages as the box lists them. */
export const outboxMessages = (outbox: Outbox): ReadonlyArray<QueuedMessage> =>
  outbox.map((entry) => ({
    kind: "user",
    id: entry.id,
    text: entry.text,
    attachments: entry.attachments,
    mentions: entry.mentions,
    status: entry.status,
    ...(entry.error === undefined ? {} : { error: entry.error }),
  }));

/** What the tray's header says of its messages. */
export const queueHeader = (queue: Queue, steered: boolean): string =>
  queue.messages.some((message) => message.status === "sending")
    ? "Sending…"
    : queue.held === "reconnecting"
      ? "Waiting to reconnect"
      : queue.held === "offline"
        ? queue.machine
          ? `Waits for ${queue.machine}`
          : "Waiting for computer"
        : steered
          ? "Sending now…"
          : queue.ended
            ? "Goes with your next message"
            : "Queued for the agent's next step";

/** The header's one line while the keyboard is up and the list folds away. */
export const collapsedHeader = (count: number, machine: string | undefined): string =>
  `${count} queued${machine ? ` · ${machine}` : ""}`;

const iconButton =
  "grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary";
const headerAction =
  "flex h-5 items-center gap-1 rounded-md px-1.5 font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary";

/** The 6px mark of a machine that can't be reached: breathing while it's being reached again. */
function HeldMark({ held }: { held: "offline" | "reconnecting" }) {
  return (
    <span aria-hidden className="grid size-3 shrink-0 place-items-center">
      <span
        className={
          held === "reconnecting"
            ? "size-1.5 animate-[pulse_1.6s_ease-in-out_infinite] rounded-full bg-attention motion-reduce:animate-none"
            : "size-1.5 rounded-full ring-1 ring-fg-disabled"
        }
      />
    </span>
  );
}

const DeviceHeld = () => (
  <span title="Kept on this device" className="flex shrink-0">
    <Smartphone aria-hidden size={11} strokeWidth={1.75} />
    <span className="sr-only">Kept on this device</span>
  </span>
);

/**
 * The queued messages at the top of the message box, numbered in the order they go: each can be
 * taken back into the draft to rewrite, or dropped. They leave as the agent takes them. While the
 * machine can't be reached they wait on this device, and go when it's back.
 */
export function QueueTray({
  queue = emptyQueue,
  onEdit,
  className,
}: {
  readonly queue?: Queue | undefined;
  /** Puts a message taken back into the draft. */
  readonly onEdit: (message: UserBlock) => void;
  readonly className: string;
}) {
  const {
    messages,
    ended,
    onSteer,
    onWithdraw,
    held,
    machine,
    onRetryNow,
    onRetryItem,
    onRestore,
    onRemove,
  } = queue;
  const steerShortcut = useShortcut("steer-now");
  const keyboard = useKeyboardOpen();
  /** Opened from its folded line while the keyboard is up; folds again with the keyboard. */
  const [expanded, setExpanded] = useState(false);
  if (expanded && !keyboard) setExpanded(false);
  /** Messages being taken back: hidden at once, and back if the agent took them first. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  /** Pressed once per wait: the messages it hands over leave with it. */
  const [steeredFor, setSteeredFor] = useState<string>();
  const pending = [...leaving].filter((id) => messages.some((message) => message.id === id));
  if (pending.length !== leaving.size) setLeaving(new Set(pending));
  const shown = messages.filter((message) => !leaving.has(message.id));
  // A message folds out of the list while others stay. The tray carries the last one away.
  const [rows, release] = useLingering(
    shown,
    (message) => message.id,
    (_, after) => after.length > 0,
  );
  const steered = steeredFor === shown[0]?.id;
  const local = shown.some(isLocal);
  const sending = shown.some((message) => message.status === "sending");
  const collapsed = held !== undefined && keyboard && !expanded;

  const withdraw = (message: UserBlock, edit: boolean) => {
    if (onWithdraw === undefined) return;
    setLeaving((current) => new Set(current).add(message.id));
    void onWithdraw(message.id).then((done) => {
      // Taken back, it stays hidden until its event removes it.
      if (done) {
        if (edit) onEdit(message);
        return;
      }
      // Refused: the agent took it, and it leaves the queue as sent; or the call failed, and it's back.
      setLeaving((current) => {
        const next = new Set(current);
        next.delete(message.id);
        return next;
      });
    });
  };

  const rowActions = (message: QueuedMessage) => {
    if (!isLocal(message)) {
      return onWithdraw ? (
        <>
          <Tooltip label="Edit">
            <Button
              aria-label="Edit queued message"
              onClick={() => withdraw(message, true)}
              className={iconButton}
            >
              <Pencil size={12} strokeWidth={1.75} />
            </Button>
          </Tooltip>
          <Tooltip label="Remove">
            <Button
              aria-label="Remove queued message"
              onClick={() => withdraw(message, false)}
              className={iconButton}
            >
              <X size={13} strokeWidth={1.75} />
            </Button>
          </Tooltip>
        </>
      ) : null;
    }
    // One on its way may already have arrived: it can't be taken back.
    if (message.status === "sending") return null;
    return (
      <>
        {message.status === "failed" ? (
          <Tooltip label="Retry">
            <Button
              aria-label="Retry sending"
              onClick={() => onRetryItem?.(message.id)}
              className={iconButton}
            >
              <RotateCcw size={12} strokeWidth={1.75} />
            </Button>
          </Tooltip>
        ) : (
          <Tooltip label="Edit">
            <Button
              aria-label="Edit queued message"
              onClick={() => onRestore?.(message.id)}
              className={iconButton}
            >
              <Pencil size={12} strokeWidth={1.75} />
            </Button>
          </Tooltip>
        )}
        <Tooltip label="Remove">
          <Button
            aria-label="Remove queued message"
            onClick={() => onRemove?.(message.id)}
            className={iconButton}
          >
            <X size={13} strokeWidth={1.75} />
          </Button>
        </Tooltip>
      </>
    );
  };

  const badge = (message: QueuedMessage) =>
    message.status === "sending" ? (
      <span className="grid size-4 shrink-0 place-items-center text-fg-tertiary">
        <RefreshCw size={10} strokeWidth={2} className="animate-spin motion-reduce:animate-none" />
      </span>
    ) : (
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-[5px] text-caption tabular-nums ring-1 ring-inset ${
          message.status === "failed" ? "text-error-text ring-error/50" : "text-fg-tertiary ring-line-strong"
        }`}
      >
        {shown.indexOf(message) + 1}
      </span>
    );

  return (
    <Reveal carry className={className}>
      {shown.length === 0 ? null : (
        <div className="mx-2.5 mt-2.5 rounded-xl border border-line-subtle p-1">
          {collapsed && held ? (
            <Button
              aria-expanded={false}
              onClick={() => setExpanded(true)}
              className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-caption text-fg-tertiary transition-colors active:bg-surface-active pointer-coarse:h-10"
            >
              <HeldMark held={held} />
              <span className="min-w-0 truncate">{collapsedHeader(shown.length, machine)}</span>
              {local ? <DeviceHeld /> : null}
            </Button>
          ) : (
            <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1 text-caption text-fg-tertiary">
              <span className="flex min-w-0 items-center gap-1.5">
                {held ? <HeldMark held={held} /> : null}
                <span className="min-w-0 truncate">{queueHeader(queue, steered)}</span>
                {local ? <DeviceHeld /> : null}
              </span>
              {held && onRetryNow && !sending ? (
                <Button onClick={onRetryNow} className={`shrink-0 ${headerAction}`}>
                  <RefreshCw size={11} strokeWidth={2} />
                  Retry now
                </Button>
              ) : onSteer && !ended && !steered && !held ? (
                <Tooltip label="Interrupt the agent and send now" shortcut={steerShortcut}>
                  <Button
                    onClick={() => {
                      setSteeredFor(shown[0]?.id);
                      onSteer();
                    }}
                    className={headerAction}
                  >
                    <CornerDownRight size={11} strokeWidth={2} />
                    Send now
                  </Button>
                </Tooltip>
              ) : null}
            </div>
          )}
          <Reveal>
            {collapsed ? null : (
              <ol>
                {rows.map(({ key, item: message, present }) => (
                  <li key={key}>
                    <Reveal onGone={() => release(key)}>
                      {present ? (
                        <div
                          title={message.status === "failed" ? message.error : undefined}
                          className="group/queued flex h-8 items-center gap-2 rounded-lg pr-1 pl-2 transition-colors hover:bg-surface-hover"
                        >
                          {badge(message)}
                          <span
                            className={`min-w-0 flex-1 truncate text-body ${
                              message.status === "sending" ? "text-fg-secondary" : "text-fg-primary"
                            }`}
                          >
                            {message.text.trim() || message.attachments.map((file) => file.name).join(", ")}
                          </span>
                          {message.attachments.length > 0 && message.text.trim() !== "" ? (
                            <span className="flex shrink-0 items-center gap-1 text-caption text-fg-tertiary">
                              <Paperclip size={11} strokeWidth={1.75} />
                              {message.attachments.length}
                            </span>
                          ) : null}
                          {rowActions(message)}
                        </div>
                      ) : null}
                    </Reveal>
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
