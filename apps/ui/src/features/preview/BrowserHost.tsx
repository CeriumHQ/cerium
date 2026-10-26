import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";

import { browserHostAtom } from "./host.ts";

/**
 * Hosts the agents' browser while mounted: the desktop window's, whose shell holds the pages. Tells
 * `onOpened` each time an agent opens a page, so its thread's preview can show.
 */
export function BrowserHost({ onOpened }: { onOpened: (threadId: string) => void }) {
  const result = useAtomValue(browserHostAtom);
  const opened = AsyncResult.isSuccess(result) ? result.value : undefined;
  const tell = useEffectEvent((threadId: string) => onOpened(threadId));
  const seq = opened?.seq;
  const threadId = opened?.threadId;
  useEffect(() => {
    if (seq !== undefined && threadId !== undefined) tell(threadId);
  }, [seq, threadId]);
  return null;
}
