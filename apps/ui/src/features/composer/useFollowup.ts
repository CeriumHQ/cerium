import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";

import { followupEventAtom } from "../../backend/atoms.ts";
import type { Followup } from "./followup.ts";

const watchVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const windowVisible = () => document.visibilityState === "visible";

export function useFollowup({
  followup,
  empty,
}: {
  readonly followup: Followup | undefined;
  readonly empty: boolean;
}) {
  const registry = useContext(RegistryContext);
  const visible = useSyncExternalStore(watchVisibility, windowVisible);
  const lead = visible && empty && followup?.ready ? followup.agentId : undefined;
  const ask = useEffectEvent((sequence: number) => followup?.suggest(sequence));
  const pending = useRef<object | undefined>(undefined);
  const [shown, setShown] = useState<{ readonly lead: string; readonly text: string }>();
  if (shown && lead !== shown.lead) setShown(undefined);

  const dismiss = () => {
    pending.current = undefined;
    setShown(undefined);
  };
  useEffect(() => {
    if (lead === undefined) return;
    const events = followupEventAtom(lead);
    // Start the stream, then listen for changes. Reopening a thread skips its last cached event.
    registry.get(events);
    const unsubscribe = registry.subscribe(events, (event) => {
      dismiss();
      if (!AsyncResult.isSuccess(event) || event.value === null || !windowVisible()) return;
      const request = {};
      pending.current = request;
      void ask(event.value)?.then(
        (text) => {
          if (text && pending.current === request) setShown({ lead, text });
        },
        () => undefined,
      );
    });
    return () => {
      unsubscribe();
      pending.current = undefined;
    };
  }, [registry, lead]);

  return { text: shown?.lead === lead ? shown?.text : undefined, dismiss };
}
