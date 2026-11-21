import { Button } from "@base-ui/react/button";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useChanged, usePresence, useRetained } from "../../lib/motion.ts";

import type { SendKey } from "../settings/preferences.ts";

/** Keeps the send and stop animation state when the controls move between editor rows. */
export function useComposerActions({
  children,
  draftKey,
  inline,
  oneLine,
  running,
  written,
  canSend,
  asksForProject,
  touch,
  sendKey,
  blockedAccess,
  onSend,
  onStop,
}: {
  readonly children: ReactNode;
  readonly draftKey: string;
  readonly inline: boolean;
  readonly oneLine: boolean;
  readonly running: boolean;
  readonly written: boolean;
  readonly canSend: boolean;
  readonly asksForProject: boolean;
  readonly touch: boolean;
  readonly sendKey: SendKey;
  readonly blockedAccess: string | undefined;
  readonly onSend: () => void;
  readonly onStop: () => void;
}) {
  const keepFocus = oneLine ? (event: MouseEvent) => event.preventDefault() : undefined;
  const discSize = oneLine
    ? "m-0.5 size-9"
    : inline
      ? "m-1 size-8 pointer-coarse:size-10 max-md:size-10"
      : "size-8 pointer-coarse:size-10 max-md:size-10";
  const actionsRow = useRef<HTMLDivElement>(null);
  const leadingActions = useRef<HTMLDivElement>(null);
  const stopDisc = useRef<HTMLSpanElement>(null);
  const sendSlot = useRef<HTMLDivElement>(null);
  const sendDisc = useRef<HTMLSpanElement>(null);
  const showSend = !running || written;
  const sendPhase = usePresence(showSend, sendDisc);
  const leavingSend = sendPhase === "leaving";
  const sendDisabled = useRetained(!canSend && !asksForProject, showSend);
  const glide = useRef({ draftKey, running, showSend, animations: [] as Animation[] });

  // Only a draft crossing empty while the turn runs shifts the controls. Move their visuals
  // from the previous slot, including any glide still in flight, while Stop's hit area snaps into place.
  useLayoutEffect(() => {
    const was = glide.current;
    const animations: Animation[] = [];
    glide.current = { draftKey, running, showSend, animations };
    const row = actionsRow.current;
    const stop = stopDisc.current;
    const slot = sendSlot.current;
    const shifted = was.draftKey === draftKey && was.running && running && was.showSend !== showSend;
    const from =
      shifted && stop && was.animations.length ? parseFloat(getComputedStyle(stop).translate) || 0 : 0;
    for (const animation of was.animations) animation.cancel();
    if (!shifted || !row || !stop || !slot || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const style = getComputedStyle(row);
    const distance = slot.offsetWidth + parseFloat(style.columnGap);
    const offset = from + (showSend ? distance : -distance);
    const timing = {
      duration: 180,
      easing: style.getPropertyValue("--ease-out-soft"),
      fill: "backwards",
    } as const;
    for (const element of [stop, leadingActions.current]) {
      if (element)
        animations.push(element.animate([{ translate: `${offset}px` }, { translate: "0px" }], timing));
    }
  }, [draftKey, inline, running, showSend]);

  useEffect(
    () => () => {
      for (const animation of glide.current.animations) animation.cancel();
    },
    [],
  );

  // Stop pops in as a turn starts, and send as it ends, once the box has seen one change.
  const turned = useChanged(running);
  const stopButton = (
    <Tooltip label="Stop" shortcut="Esc">
      <Button
        onClick={onStop}
        onMouseDown={keepFocus}
        aria-label="Stop"
        className={`group relative z-1 shrink-0 rounded-full ${discSize}`}
      >
        {/* The ring turns with the disc, so the one control that ends the turn stands out. */}
        <span
          ref={stopDisc}
          className={`pointer-events-none relative grid size-full place-items-center rounded-full bg-accent text-accent-fg shadow-button transition-[opacity,scale,filter] before:absolute ${turned ? "swap-in" : ""} before:-inset-1 before:animate-spin before:rounded-full before:border-[1.5px] before:border-transparent before:border-t-fg-secondary group-hover:opacity-90 group-active:scale-95 motion-reduce:transition-none motion-reduce:before:animate-none`}
        >
          <Square size={11} fill="currentColor" strokeWidth={0} />
        </span>
      </Button>
    </Tooltip>
  );
  const sendLabel =
    blockedAccess ?? (asksForProject ? "Choose a project first" : running ? "Send after this turn" : "Send");
  const sendPops = turned || (running && sendPhase === "entering");
  // The glass can change rows as the draft clears. Send still fades from a full disc in the new row.
  const sendMotion = leavingSend
    ? "scale-[0.85] opacity-0 transition-[opacity,scale,filter] duration-150 ease-in-soft starting:scale-100 starting:opacity-100"
    : `transition-[opacity,scale,filter,background-color] group-hover:opacity-90 group-active:scale-95 group-disabled:opacity-100 ${sendPops ? "swap-in" : ""}`;
  const sendButton = (
    <Tooltip
      label={sendLabel}
      {...(touch || asksForProject ? {} : { shortcut: sendKey === "enter" ? "Enter" : "Ctrl Enter" })}
    >
      <Button
        onClick={onSend}
        onMouseDown={keepFocus}
        disabled={sendDisabled}
        aria-label={sendLabel}
        className={`group block shrink-0 rounded-full ${discSize}`}
      >
        {/* An empty draft gets an outlined ring. The disc pops without scaling the hit area. */}
        <span
          ref={sendDisc}
          className={`pointer-events-none grid size-full place-items-center rounded-full bg-accent text-accent-fg shadow-button group-disabled:shadow-none group-disabled:bg-transparent group-disabled:text-fg-tertiary group-disabled:ring-1 group-disabled:ring-line-strong group-disabled:ring-inset ${sendMotion}`}
        >
          <ArrowUp size={16} strokeWidth={2.25} />
        </span>
      </Button>
    </Tooltip>
  );
  // While a turn runs, a message written meanwhile waits for it to end, so send stays beside stop. The
  // model chip leads the right-hand group with access after it, what the message goes to and how it
  // may act; dictation sits by send, both being how the message is written and sent.
  return (
    <div ref={actionsRow} className="relative isolate flex min-w-0 shrink-0 items-center gap-1">
      <div ref={leadingActions} className="flex min-w-0 items-center gap-1 empty:hidden">
        {children}
      </div>
      {running ? stopButton : null}
      {/* Send leaves from the right edge while the row closes the gap underneath it. */}
      {sendPhase === "gone" ? null : (
        <div
          ref={sendSlot}
          inert={leavingSend}
          className={`z-2 ${leavingSend ? "pointer-events-none absolute end-0 top-1/2 -translate-y-1/2" : "relative"}`}
        >
          {sendButton}
        </div>
      )}
    </div>
  );
}
