import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import { createContext, use, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useRetained } from "../lib/motion.ts";

/** Whether the view reading it is kept out of sight. */
const KeptHidden = createContext(false);

/**
 * Whether the view is kept out of sight, mounted as it was left: it takes no keys, and reads with
 * `useKeptResult` hold what they showed.
 */
export const useKeptHidden = () => use(KeptHidden);

/**
 * The views shown last in one place, by key: the one `shown` names shows, and up to `limit` of the
 * others stay mounted out of sight, so going back to one shows it at once, as it was left. Building a
 * long thread's conversation afresh took a few hundred milliseconds. The one shown longest ago goes
 * to make room for another.
 *
 * A hidden view keeps its layout, scroll position and finished animations under
 * `content-visibility: hidden`; `display: none` would drop its layout and play every entrance
 * again as it showed.
 */
export function KeptViews({
  shown,
  limit,
  children,
}: {
  shown: string | undefined;
  limit: number;
  /** The view `shown` names. */
  children: ReactNode;
}) {
  // In the order they first showed, so showing another never moves one in the document: a view moved
  // is laid out afresh, and its frames load again.
  const [kept, setKept] = useState<{
    readonly order: ReadonlyArray<string>;
    /** The latest shown first. */
    readonly recent: ReadonlyArray<string>;
  }>({ order: [], recent: [] });
  if (shown !== undefined && kept.recent[0] !== shown) {
    const recent = [shown, ...kept.recent.filter((key) => key !== shown)];
    const stays = new Set(recent.slice(0, limit + 1));
    setKept({
      order: [...kept.order, ...(kept.order.includes(shown) ? [] : [shown])].filter((key) => stays.has(key)),
      recent: recent.filter((key) => stays.has(key)),
    });
  }
  return kept.order.map((key) => (
    <Kept key={key} hidden={key !== shown}>
      {key === shown ? children : null}
    </Kept>
  ));
}

/** One view of `KeptViews`, laid over the others; hidden, it holds what it last showed. */
function Kept({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const view = useRetained(children, !hidden);
  return (
    <KeptHidden value={hidden}>
      <div inert={hidden} className={`absolute inset-0 ${hidden ? "[content-visibility:hidden]" : ""}`}>
        {view}
      </div>
    </KeptHidden>
  );
}

const unsubscribed = () => () => undefined;

/**
 * An atom's result, followed while its view shows. Kept out of sight, the view holds the result it
 * last showed and stops reading, so a thread at work out of sight doesn't render its conversation
 * again for every word it streams. Back in sight, it keeps showing that result until the atom has
 * one again, should it have been let go of in the meantime.
 */
export function useKeptResult<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): AsyncResult.AsyncResult<A, E> {
  const hidden = useKeptHidden();
  const registry = use(RegistryContext);
  const shown = useRef<{
    readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
    readonly result: AsyncResult.AsyncResult<A, E>;
  }>(undefined);
  const snapshot = () => {
    const held = shown.current?.atom === atom ? shown.current.result : undefined;
    if (hidden && held !== undefined) return held;
    const result = registry.get(atom);
    if (held !== undefined && !AsyncResult.isSuccess(result) && AsyncResult.isSuccess(held)) return held;
    shown.current = { atom, result };
    return result;
  };
  return useSyncExternalStore(
    hidden ? unsubscribed : (onChange: () => void) => registry.subscribe(atom, onChange),
    snapshot,
  );
}
