import { Button } from "@base-ui/react/button";
import { CornerDownRight, Paperclip, Pencil, X } from "lucide-react";
import { useState } from "react";

import { Reveal } from "../../components/Reveal.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useLingering } from "../../lib/motion.ts";
import type { UserBlock } from "../transcript/model.ts";

/** The user's messages waiting for the lead, as the message box shows them. */
export interface Queue {
  readonly messages: ReadonlyArray<UserBlock>;
  /** The lead ended: they go with the user's next message rather than at the agent's next step. */
  readonly ended: boolean;
  /** Interrupts the turn to hand them over now; absent where they can only wait. */
  readonly onSteer?: (() => void) | undefined;
  /** Takes one back; resolves false when the agent took it first. Absent where the machine can't. */
  readonly onWithdraw?: ((messageId: string) => Promise<boolean>) | undefined;
}

const iconButton =
  "grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary";

/**
 * The queued messages at the top of the message box, numbered in the order they go: each can be
 * taken back into the draft to rewrite, or dropped. They leave as the agent takes them.
 */
export function QueueTray({
  queue,
  onEdit,
}: {
  readonly queue: Queue;
  /** Puts a message taken back into the draft. */
  readonly onEdit: (message: UserBlock) => void;
}) {
  const { messages, ended, onSteer, onWithdraw } = queue;
  /** Messages being taken back: hidden at once, and back if the agent took them first. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  /** Pressed once per wait: the messages it hands over leave with it. */
  const [steeredFor, setSteeredFor] = useState<string>();
  const shown = messages.filter((message) => !leaving.has(message.id));
  // A message the agent takes, or that's taken back, folds out of the list.
  const [rows, release] = useLingering(shown, (message) => message.id);
  const steered = steeredFor === shown[0]?.id;

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

  return (
    <Reveal>
      {shown.length === 0 ? null : (
        <div className="mx-2.5 mt-2.5 rounded-xl border border-line-subtle p-1">
          <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1 text-caption text-fg-tertiary">
            <span>
              {steered
                ? "Sending now…"
                : ended
                  ? "Goes with your next message"
                  : "Queued for the agent's next step"}
            </span>
            {onSteer && !ended && !steered ? (
              <Tooltip label="Interrupt the agent and send now">
                <Button
                  onClick={() => {
                    setSteeredFor(shown[0]?.id);
                    onSteer();
                  }}
                  className="flex h-5 items-center gap-1 rounded-md px-1.5 font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                >
                  <CornerDownRight size={11} strokeWidth={2} />
                  Send now
                </Button>
              </Tooltip>
            ) : null}
          </div>
          <ol>
            {rows.map(({ key, item: message, present }) => (
              <li key={key}>
                <Reveal onGone={() => release(key)}>
                  {present ? (
                    <div className="group/queued flex h-8 items-center gap-2 rounded-lg pr-1 pl-2 transition-colors hover:bg-surface-hover">
                      <span className="grid size-4 shrink-0 place-items-center rounded-[5px] text-[10.5px] text-fg-tertiary tabular-nums ring-1 ring-line-strong ring-inset">
                        {shown.indexOf(message) + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body text-fg-primary">
                        {message.text.trim() || message.attachments.map((file) => file.name).join(", ")}
                      </span>
                      {message.attachments.length > 0 && message.text.trim() !== "" ? (
                        <span className="flex shrink-0 items-center gap-1 text-caption text-fg-tertiary">
                          <Paperclip size={11} strokeWidth={1.75} />
                          {message.attachments.length}
                        </span>
                      ) : null}
                      {onWithdraw ? (
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
                      ) : null}
                    </div>
                  ) : null}
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Reveal>
  );
}
