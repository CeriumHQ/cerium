import { RegistryContext } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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
  running,
}: {
  readonly followup: Followup | undefined;
  readonly empty: boolean;
  readonly running: boolean;
}) {
  const registry = useContext(RegistryContext);
  const visible = useSyncExternalStore(watchVisibility, windowVisible);
  const lead = visible && empty && followup?.ready ? followup.agentId : undefined;
  const ask = useEffectEvent((sequence: number) => followup?.suggest(sequence));
  const pending = useRef<object | undefined>(undefined);
  const [reply, setReply] = useState<{
    readonly lead: string;
    readonly text: string;
    readonly completedAt: number;
  }>();
  const [shown, setShown] = useState<typeof reply>();
  const idleAt = useRef(0);
  if (reply && lead !== reply.lead) setReply(undefined);

  const dismiss = () => {
    pending.current = undefined;
    setReply(undefined);
    setShown(undefined);
  };

  useLayoutEffect(() => {
    if (!running) idleAt.current = performance.now();
  }, [running]);

  useLayoutEffect(() => {
    if (!reply || reply.lead !== lead || running) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const duration = getComputedStyle(document.documentElement).getPropertyValue("--turn-end-duration");
    const milliseconds = parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1_000);
    // The completion event and the composer can update separately. Wait from the later one.
    const delay = Math.max(reply.completedAt, idleAt.current) + milliseconds - performance.now();
    if (motion.matches || !(delay > 0)) {
      setShown(reply);
      return;
    }
    const timer = setTimeout(() => setShown(reply), delay);
    const reduce = () => {
      if (!motion.matches) return;
      clearTimeout(timer);
      setShown(reply);
    };
    motion.addEventListener("change", reduce);
    return () => {
      clearTimeout(timer);
      motion.removeEventListener("change", reduce);
    };
  }, [lead, reply, running]);

  useEffect(() => {
    if (lead === undefined) return;
    const events = followupEventAtom(lead);
    // Start the stream, then listen for changes. Reopening a thread skips its last cached event.
    registry.get(events);
    const unsubscribe = registry.subscribe(events, (event) => {
      dismiss();
      if (!AsyncResult.isSuccess(event) || event.value === null || !windowVisible()) return;
      const request = {};
      const completedAt = performance.now();
      pending.current = request;
      void ask(event.value)?.then(
        (text) => {
          if (text && pending.current === request) setReply({ lead, text, completedAt });
        },
        () => undefined,
      );
    });
    return () => {
      unsubscribe();
      pending.current = undefined;
    };
  }, [registry, lead]);

  return { text: !running && reply === shown && shown?.lead === lead ? shown?.text : undefined, dismiss };
}
