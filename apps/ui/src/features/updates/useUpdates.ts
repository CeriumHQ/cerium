import { useEffect, useState } from "react";

import { shellBridge, type Updates } from "../../backend/shell.ts";

/** What the shell's updater knows, kept current; undefined outside the desktop app. */
export function useUpdates(): Updates | undefined {
  const [updates, setUpdates] = useState<Updates>();
  useEffect(() => {
    const bridge = shellBridge();
    const stop = bridge?.onUpdatesChange?.(setUpdates);
    void bridge?.updates?.().then(
      (current) => setUpdates((latest) => latest ?? current),
      () => undefined,
    );
    return stop;
  }, []);
  return updates;
}
