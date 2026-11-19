import { CircleAlert, CircleArrowUp, TriangleAlert, X } from "lucide-react";
import { useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { settled, useLingering } from "../lib/motion.ts";

const SWAP_MS = 200;

/** Crossfades keyed views and resizes their shared box as they trade places. */
export function NoticeSwap({
  kind,
  children,
  className = "",
}: {
  kind: string;
  children: ReactNode;
  className?: string;
}) {
  const items = useMemo(() => [{ kind, children }], [kind, children]);
  const [views, release] = useLingering(items, (view) => view.kind);
  const releaseView = useEffectEvent(release);
  const box = useRef<HTMLDivElement>(null);
  const previousKind = useRef(kind);

  useLayoutEffect(() => {
    const before = previousKind.current;
    previousKind.current = kind;
    const element = box.current;
    if (!element || before === kind) return;

    const layers = Array.from(element.querySelectorAll<HTMLElement>(":scope > [data-notice-view]"));
    const previous = layers.find((layer) => layer.dataset.noticeView === before);
    const active = layers.find((layer) => layer.dataset.noticeView === kind);
    if (!previous || !active) return;

    // A second swap starts from the height and opacities already on screen.
    const moveFocus = previous.contains(document.activeElement);
    const [resize] = element.getAnimations();
    const from = getComputedStyle(resize ? element : previous).height;
    const to = getComputedStyle(active).height;
    const fades = layers.map((layer) => {
      const [fade] = layer.getAnimations();
      const opacity = fade ? Number(getComputedStyle(layer).opacity) : layer === previous ? 1 : 0;
      fade?.cancel();
      return { layer, opacity };
    });
    resize?.cancel();

    const clear = () => {
      for (const layer of layers) {
        if (layer !== active) releaseView(layer.dataset.noticeView!);
      }
    };
    if (moveFocus) {
      const target = active.querySelector<HTMLElement>("[data-notice-focus]") ?? element;
      target.focus({ preventScroll: true });
    }

    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) {
      clear();
      return;
    }

    const timing: KeyframeAnimationOptions = {
      duration: SWAP_MS,
      easing: getComputedStyle(element).getPropertyValue("--ease-out-soft").trim() || "ease-out",
      fill: "backwards",
    };
    const running = fades.map(({ layer, opacity }) =>
      layer.animate([{ opacity }, { opacity: layer === active ? 1 : 0 }], timing),
    );
    if (from !== to) running.push(element.animate([{ height: from }, { height: to }], timing));

    let live = true;
    const finish = () => {
      if (!live) return;
      live = false;
      motion.removeEventListener("change", reduce);
      clear();
    };
    const reduce = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      for (const animation of running) animation.cancel();
      finish();
    };
    motion.addEventListener("change", reduce);
    void Promise.all([settled(element), ...layers.map(settled)]).then(finish);
    return () => {
      live = false;
      motion.removeEventListener("change", reduce);
    };
  }, [kind]);

  return (
    <div
      ref={box}
      tabIndex={-1}
      className={`relative ${views.length > 1 ? "overflow-clip" : ""} ${className}`}
    >
      {views.map(({ item, key, present }) => (
        <div
          key={key}
          data-notice-view={key}
          inert={!present}
          aria-hidden={!present || undefined}
          className={present ? "relative" : "pointer-events-none absolute inset-x-0 top-0 opacity-0"}
        >
          {item.children}
        </div>
      ))}
    </div>
  );
}

type NoticeTone = "attention" | "error" | "update";
const dismissSlot = "-my-0.5 -mr-1 size-6 shrink-0 max-md:-my-1.5 max-md:size-8";

/**
 * A slim bar across the top of the transcript for problems worth the user's attention, or news that
 * asks for a decision, such as an update to install.
 *
 * `clamp` is for text whose length isn't ours to choose, such as an error a backend reports: it shows
 * two lines and unfolds on request. Leave it off where the notice carries links, which would fold away.
 */
export function Notice({
  tone,
  children,
  onDismiss,
  clamp = false,
  kind,
}: {
  tone: NoticeTone;
  children: ReactNode;
  onDismiss?: (() => void) | undefined;
  clamp?: boolean;
  /** Gives each body its own view for a swap, with the dismiss button outside it. */
  kind?: string;
}) {
  const dismissButton = useRef<HTMLButtonElement>(null);
  const dismissible = onDismiss !== undefined;
  useLayoutEffect(() => {
    const button = dismissButton.current;
    // Installing hides Dismiss. Keep focus on the notice if it was on that button.
    if (!dismissible && button && document.activeElement === button) {
      button.parentElement?.focus({ preventScroll: true });
    }
  }, [dismissible]);

  const body = (
    <NoticeBody tone={tone} clamp={clamp}>
      {children}
    </NoticeBody>
  );
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      tabIndex={kind === undefined ? undefined : -1}
      style={kind === undefined ? undefined : { transitionDuration: `${SWAP_MS}ms` }}
      className={`flex shrink-0 items-start gap-2 border-b px-4 py-2 text-meta leading-[1.4] text-fg-secondary max-md:text-[13px] [&_code]:rounded [&_code]:bg-surface-hover [&_code]:px-1 [&_code]:font-mono [&_code]:text-caption [&_code]:text-fg-primary ${
        tone === "error"
          ? "border-error/25 bg-error/6"
          : tone === "update"
            ? "border-accent/25 bg-accent/6"
            : "border-attention/25 bg-attention/6"
      } ${kind === undefined ? "" : "relative transition-colors ease-out-soft motion-reduce:transition-none"}`}
    >
      {kind === undefined ? (
        body
      ) : (
        <NoticeSwap kind={kind} className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            {body}
            {/* Each view keeps its own text width, including when installing removes dismiss. */}
            {onDismiss ? <span aria-hidden className={dismissSlot} /> : null}
          </div>
        </NoticeSwap>
      )}
      {dismissible || kind !== undefined ? (
        <button
          ref={dismissButton}
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`relative grid place-items-center rounded text-fg-tertiary hover:bg-surface-hover hover:text-fg-secondary max-md:after:absolute max-md:after:-inset-2 ${dismissSlot} ${kind === undefined ? "" : "absolute top-2 right-4"} ${dismissible ? "" : "invisible"}`}
        >
          <X size={12} strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

function NoticeBody({ tone, clamp, children }: { tone: NoticeTone; clamp: boolean; children: ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : tone === "update" ? CircleArrowUp : TriangleAlert;
  const [expanded, setExpanded] = useState(false);
  /** Whether the text runs past its two lines, so there's something to unfold. */
  const [overflowing, setOverflowing] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = text.current;
    if (!clamp || !element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    // A narrower window wraps the same text onto more lines.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clamp, expanded, children]);
  return (
    <>
      {/* One line tall, so the icon sits on the first line of text however long the rest runs. */}
      <span className="grid h-[1.4em] shrink-0 place-items-center">
        <Icon
          size={13}
          strokeWidth={2}
          className={
            tone === "error"
              ? "text-error-text"
              : tone === "update"
                ? "text-accent-text"
                : "text-attention-text"
          }
        />
      </span>
      <span ref={text} className={`min-w-0 flex-1 ${clamp && !expanded ? "line-clamp-2" : ""}`}>
        {children}
      </span>
      {clamp && (overflowing || expanded) ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="shrink-0 rounded px-1 font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary"
        >
          {expanded ? "Less" : "More"}
        </button>
      ) : null}
    </>
  );
}
