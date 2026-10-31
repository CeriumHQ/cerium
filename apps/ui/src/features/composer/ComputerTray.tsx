import { Button } from "@base-ui/react/button";
import type { ThreadId } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";

import { computerUseAtom, stopComputerUse } from "../../backend/computerUse.ts";
import { Reveal } from "../../components/Reveal.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { elapsed } from "../dictation/model.ts";

/**
 * The thread's agents at work on the user's own computer (computer use), at the top of the message
 * box while they are: whose cursors are on screen, for how long, and the way to stop them. Stopping
 * takes their cursors away and refuses their next calls until the user writes in the thread again.
 */
export function ComputerTray({ threadId }: { readonly threadId: ThreadId }) {
  const status = AsyncResult.getOrElse(useAtomValue(computerUseAtom), () => undefined);
  const stop = useAtomSet(stopComputerUse, { mode: "promise" });
  /** When the use the user stopped began: a later one, after they wrote again, offers Stop anew. */
  const [stoppedAt, setStoppedAt] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const sessions = status?.sessions.filter((session) => session.threadId === threadId) ?? [];
  const using = sessions.length > 0;

  useEffect(() => {
    if (!using) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [using]);

  const busy = sessions.some((session) => session.busy);
  const since = Math.min(...sessions.map((session) => session.startedAt));
  const stopping = stoppedAt === since;

  const onStop = () => {
    setStoppedAt(since);
    stop({ payload: { threadId } }).then(
      () => undefined,
      // Refused: the button comes back.
      () => setStoppedAt(undefined),
    );
  };

  return (
    <Reveal>
      {using ? (
        <div className="mx-2.5 mt-2.5 rounded-xl border border-line-subtle p-1">
          <div className="flex h-8 items-center gap-2 rounded-lg pr-1 pl-2">
            <span
              aria-hidden
              className={`size-1.5 shrink-0 rounded-full bg-running ${busy ? "animate-pulse" : "opacity-60"}`}
            />
            <MousePointer2 size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 text-body text-fg-primary">Using your computer</span>
              <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
                {sessions.map((session) => session.label).join(", ")}
              </span>
            </span>
            <span className="shrink-0 text-caption text-fg-tertiary tabular-nums">
              {elapsed(now - since)}
            </span>
            <Tooltip label="Stop them using your computer">
              <Button
                aria-label="Stop using your computer"
                disabled={stopping}
                onClick={onStop}
                className="flex h-6 shrink-0 items-center rounded-md border border-line-subtle px-2 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:pointer-events-none disabled:opacity-50"
              >
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            </Tooltip>
          </div>
        </div>
      ) : null}
    </Reveal>
  );
}
