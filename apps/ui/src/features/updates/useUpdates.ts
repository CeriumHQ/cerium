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

/**
 * Restarts into the downloaded update. While agents are working it holds back and `confirming`
 * says so, until the user restarts anyway or lets it wait.
 */
export function useRestartToUpdate() {
  const [confirming, setConfirming] = useState(false);
  const restart = (anyway = false) => {
    void shellBridge()
      ?.installUpdate?.(anyway)
      .then(
        (result) => setConfirming(result === "working"),
        () => setConfirming(false),
      );
  };
  return { confirming, restart, cancel: () => setConfirming(false) };
}
