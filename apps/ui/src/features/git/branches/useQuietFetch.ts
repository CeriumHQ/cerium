import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useEffect, useEffectEvent } from "react";

import { branchBusyAtom, fetchedAtAtom, gitQuietFetch, refreshBranches } from "../../../backend/branches.ts";
import { QUIET_FETCH_EVERY_MS } from "./model.ts";

/** How often to look at whether a fetch is due. */
const LOOK_EVERY_MS = 60_000;

/**
 * Keeps the remote's news coming while the panel is open: a fetch when it opens and then every few
 * minutes, only while the window is in view and nothing else is being changed. It never asks for a
 * password, and a failure (offline, signed out) is left for the user's own Fetch to explain.
 */
export function useQuietFetch(root: string, hasRemote: boolean) {
  const registry = useContext(RegistryContext);
  const fetch = useAtomSet(gitQuietFetch, { mode: "promise" });

  const fetchIfDue = useEffectEvent(async () => {
    if (document.visibilityState === "hidden") return;
    if (registry.get(branchBusyAtom(root)) !== undefined) return;
    const last = registry.get(fetchedAtAtom(root));
    if (last !== undefined && Date.now() - last < QUIET_FETCH_EVERY_MS) return;
    try {
      const result = await fetch({ payload: { root, quiet: true } });
      registry.set(fetchedAtAtom(root), Date.now());
      if (result.unchanged !== true) refreshBranches(registry, root);
    } catch {
      // Not the user's doing, so not their news.
    }
  });

  useEffect(() => {
    if (!hasRemote) return;
    void fetchIfDue();
    const timer = setInterval(() => void fetchIfDue(), LOOK_EVERY_MS);
    const onVisible = () => void fetchIfDue();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [root, hasRemote]);
}
