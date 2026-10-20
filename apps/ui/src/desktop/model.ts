import type { NotificationKind, ThreadNotification } from "@cerium/protocol";

// When the desktop's own notifications show, and what its taskbar badge reads.

/** What the user sees of the window: whether it's in front of them, and the thread open in it. */
export interface Looking {
  /** The window shows and has the focus. */
  readonly atWindow: boolean;
  readonly viewing: string | undefined;
}

/**
 * What a notification that arrived does: nothing when its kind is off or the user is looking at
 * its thread; it counts on the taskbar while they're in another one; it shows when they're away.
 * A usage limit belongs to no thread, so it shows whatever the user looks at: no open page tells them.
 */
export const handling = (
  notification: Pick<ThreadNotification, "threadId" | "kind">,
  kinds: ReadonlyArray<NotificationKind>,
  looking: Looking,
): "ignore" | "count" | "show" => {
  if (!kinds.includes(notification.kind)) return "ignore";
  if (notification.kind === "limit") return "show";
  if (looking.atWindow && looking.viewing === notification.threadId) return "ignore";
  return looking.atWindow ? "count" : "show";
};

/** What the taskbar badge reads for this many threads. */
export const badgeText = (count: number) => (count > 9 ? "9+" : String(count));
