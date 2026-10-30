import { Button } from "@base-ui/react/button";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { ThreadHistory } from "../../backend/threadLog.ts";
import { REVEAL_EVENT } from "./useStickToBottom.ts";

/** Navigation names one model item; it never asks to mount the entire conversation. */
export const HISTORY_EVENT = "cerium:history";
export const HISTORY_PAGE = 80;
export const HISTORY_MOUNT_LIMIT = 160;
export interface HistoryTarget {
  readonly id: string;
}

/** A bounded, overlapping page around the reading position, or the live tail while following. */
export function HistoryWindow<A extends { readonly id: string }>({
  items,
  viewport,
  render,
  history,
  following = true,
  contains,
  onReveal,
  onTailMounted,
}: {
  items: ReadonlyArray<A>;
  viewport: RefObject<HTMLDivElement | null>;
  render: (item: A) => ReactNode;
  history?: Pick<ThreadHistory, "more" | "loadOlder" | "pageRevision" | "loadError"> | undefined;
  following?: boolean;
  contains?: ((item: A, id: string) => boolean) | undefined;
  onReveal?: (() => void) | undefined;
  onTailMounted?: ((mounted: boolean) => void) | undefined;
}) {
  const [first, setFirst] = useState<string>();
  const [selected, setSelected] = useState(false);
  const [loading, setLoading] = useState(false);
  const anchor = useRef<{ element: Element; top: number }>(undefined);
  const pending = useRef<{ id: string; length: number; revision: number | undefined }>(undefined);
  const tail = Math.max(0, items.length - HISTORY_PAGE);
  const index = first === undefined ? tail : items.findIndex((item) => item.id === first);
  const start = following && !selected ? tail : index < 0 ? tail : index;
  const end = Math.min(items.length, start + HISTORY_MOUNT_LIMIT);
  useLayoutEffect(() => {
    onTailMounted?.(end === items.length);
  }, [end, items.length, onTailMounted]);

  const hold = () => {
    const view = viewport.current;
    if (!view) return;
    onReveal?.();
    view.dispatchEvent(new Event(REVEAL_EVENT, { bubbles: true }));
    const top = view.getBoundingClientRect().top;
    const element = [...view.querySelectorAll("[data-history-id]")].find(
      (node) => node.getBoundingClientRect().bottom > top,
    );
    if (element) anchor.current = { element, top: element.getBoundingClientRect().top };
  };
  const reveal = useEffectEvent((event: Event) => {
    if (!viewport.current?.checkVisibility()) return;
    const id = (event as CustomEvent<HistoryTarget>).detail?.id;
    if (id === undefined) return;
    const at = items.findIndex((item) => item.id === id || contains?.(item, id));
    if (at < 0) return;
    onReveal?.();
    viewport.current.dispatchEvent(new Event(REVEAL_EVENT, { bubbles: true }));
    setFirst(items[Math.max(0, at - HISTORY_PAGE / 2)]?.id);
  });
  useEffect(() => {
    const navigate = (event: Event) => reveal(event);
    const selection = () => {
      const selection = document.getSelection();
      const inView =
        selection !== null &&
        !selection.isCollapsed &&
        viewport.current?.contains(selection.anchorNode) === true;
      setSelected(inView);
    };
    window.addEventListener(HISTORY_EVENT, navigate);
    document.addEventListener("selectionchange", selection);
    return () => {
      window.removeEventListener(HISTORY_EVENT, navigate);
      document.removeEventListener("selectionchange", selection);
    };
  }, [viewport]);
  if (following && !selected && first !== items[tail]?.id) setFirst(items[tail]?.id);

  useLayoutEffect(() => {
    const request = pending.current;
    if (
      request &&
      (request.length !== items.length || request.revision !== history?.pageRevision || !history?.more)
    ) {
      const previous = items.findIndex((item) => item.id === request.id);
      pending.current = undefined;
      setLoading(false);
      setFirst(items[Math.max(0, previous - HISTORY_PAGE)]?.id);
      return;
    }
    const held = anchor.current;
    if (held?.element.isConnected && viewport.current) {
      viewport.current.scrollBy({
        top: held.element.getBoundingClientRect().top - held.top,
        behavior: "instant",
      });
      anchor.current = undefined;
    }
  }, [start, items, viewport, history?.pageRevision, history?.more]);

  const earlier = () => {
    hold();
    if (start > 0) setFirst(items[Math.max(0, start - HISTORY_PAGE)]?.id);
    else if (history?.more && history.loadOlder) {
      pending.current = { id: items[start]?.id ?? "", length: items.length, revision: history.pageRevision };
      setLoading(true);
      history.loadOlder();
    }
  };
  const button =
    "self-center rounded-md px-3 py-2 text-meta text-fg-secondary hover:bg-surface-hover disabled:opacity-50";
  return (
    <>
      {history?.loadError ? (
        <output className="self-center text-meta text-fg-secondary">{history.loadError}</output>
      ) : null}
      {start > 0 || history?.more ? (
        <Button className={button} disabled={loading} onClick={earlier}>
          {loading ? "Loading earlier messages…" : "Show earlier messages"}
        </Button>
      ) : null}
      {items.slice(start, end).map((item) => (
        <div key={item.id} data-history-id={item.id} className="flex min-w-0 flex-col gap-3">
          {render(item)}
        </div>
      ))}
      {end < items.length ? (
        <Button
          className={button}
          onClick={() => {
            hold();
            setFirst(items[Math.min(tail, start + HISTORY_PAGE)]?.id);
          }}
        >
          Show later messages
        </Button>
      ) : null}
    </>
  );
}
