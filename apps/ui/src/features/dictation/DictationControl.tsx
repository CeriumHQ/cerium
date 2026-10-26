import { Button } from "@base-ui/react/button";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type MouseEvent } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useChanged } from "../../lib/motion.ts";
import { useShortcut } from "../../lib/shortcuts.ts";
import { elapsed, problemText } from "./model.ts";
import type { Dictation } from "./useDictation.ts";

// Control stays the Control key itself, even on a Mac where ⌘M minimizes (lib/shortcuts.ts).

/** Clicking keeps the cursor in the message, where the words go. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** Bars that follow how loud the user is, redrawn each frame without re-rendering. */
function LevelMeter({ level }: { level: () => number }) {
  const bars = useRef<HTMLSpanElement>(null);
  const read = useEffectEvent(level);
  useEffect(() => {
    let frame = 0;
    let smooth = 0;
    const shape = [0.55, 1, 0.75, 0.9];
    const draw = (time: number) => {
      smooth += (read() - smooth) * 0.35;
      const children = bars.current?.children ?? [];
      for (let index = 0; index < children.length; index++) {
        // A little movement of each bar's own, so the meter reads as live even at an even tone.
        const wobble = 0.85 + 0.15 * Math.sin(time / 90 + index * 1.7);
        const height = Math.max(0.18, Math.min(1, smooth * (shape[index] ?? 1) * wobble));
        (children[index] as HTMLElement).style.transform = `scaleY(${height})`;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span ref={bars} aria-hidden className="flex h-3.5 items-center gap-[2px]">
      {[0, 1, 2, 3].map((bar) => (
        <span key={bar} className="h-full w-[2.5px] origin-center scale-y-[0.18] rounded-full bg-current" />
      ))}
    </span>
  );
}

/** The recording's running time, ticking each second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return <span className="w-8 text-left tabular-nums">{elapsed(now - since)}</span>;
}

/**
 * The message box's microphone: a button to start dictating, and while it listens, a pill with the
 * time and a level meter that stops it. Its download shows here the first time.
 */
export function DictationControl({ dictation }: { dictation: Dictation }) {
  const dictateKeys = useShortcut("dictate");
  const { state, download } = dictation;
  // Each of the microphone, the recording pill and the writing pill pops in as it takes the place.
  const form =
    state.phase === "recording" || state.phase === "starting"
      ? "recording"
      : state.phase === "finishing"
        ? "writing"
        : "idle";
  const swap = useChanged(form) ? "swap-in" : "";
  const downloading =
    download === undefined ? null : (
      <span className="text-fg-tertiary tabular-nums">Model {Math.round(download * 100)}%</span>
    );

  if (form === "recording") {
    return (
      <Tooltip label="Stop dictating" shortcut={dictateKeys}>
        <Button
          onClick={dictation.toggle}
          onMouseDown={keepFocus}
          aria-label="Stop dictating"
          className={`flex h-8 shrink-0 items-center gap-2 rounded-full border border-error/30 bg-error/10 pr-3 pl-2.5 text-meta text-fg-primary transition-[background-color,opacity,scale,filter] hover:bg-error/18 ${swap}`}
        >
          <span className="grid size-4 place-items-center text-error">
            <Square size={10} fill="currentColor" strokeWidth={0} />
          </span>
          {state.phase === "recording" ? (
            <>
              <span className="text-error">
                <LevelMeter level={dictation.level} />
              </span>
              <Elapsed since={state.since} />
            </>
          ) : (
            <span className="text-fg-secondary">Starting…</span>
          )}
          {downloading}
        </Button>
      </Tooltip>
    );
  }

  if (form === "writing") {
    return (
      <output
        className={`flex h-8 shrink-0 items-center gap-2 rounded-full bg-surface-hover px-3 text-meta text-fg-secondary ${swap}`}
      >
        <LoaderCircle size={13} className="animate-spin" />
        {download === undefined ? "Writing…" : downloading}
      </output>
    );
  }

  return (
    <Tooltip label="Dictate" shortcut={dictateKeys}>
      <Button
        onClick={dictation.toggle}
        onMouseDown={keepFocus}
        aria-label="Dictate"
        className={`grid size-8 shrink-0 place-items-center rounded-full text-fg-tertiary transition-[color,background-color,opacity,scale,filter] hover:bg-surface-hover hover:text-fg-secondary active:bg-surface-active ${swap}`}
      >
        <Mic size={15} strokeWidth={1.75} />
      </Button>
    </Tooltip>
  );
}

/** Why dictation stopped, above the message, with what the user can do about it. */
export function DictationNotice({ dictation }: { dictation: Dictation }) {
  const { state } = dictation;
  if (state.phase !== "failed") return null;
  const bridge = shellBridge();
  const action =
    state.problem === "blocked" && bridge?.openMicrophoneSettings
      ? { label: "Open privacy settings", run: () => void bridge.openMicrophoneSettings?.() }
      : state.problem === "download" || state.problem === "busy"
        ? { label: "Try again", run: dictation.toggle }
        : undefined;
  const quiet = state.problem === "silent";
  return (
    <div
      role="alert"
      className={`mx-3 mt-3 flex items-center gap-2 rounded-lg border py-1.5 pr-1.5 pl-3 text-meta ${
        quiet
          ? "border-line-subtle bg-surface-hover text-fg-secondary"
          : "border-error/25 bg-error/6 text-fg-primary"
      }`}
    >
      <Mic size={13} strokeWidth={1.75} className={quiet ? "text-fg-tertiary" : "text-error"} />
      <span className="min-w-0 flex-1 truncate">{problemText[state.problem]}</span>
      {action ? (
        <Button
          onClick={action.run}
          onMouseDown={keepFocus}
          className="h-6 shrink-0 rounded-md px-2 font-medium text-fg-primary transition-colors hover:bg-surface-hover"
        >
          {action.label}
        </Button>
      ) : null}
      <Button
        onClick={dictation.dismiss}
        onMouseDown={keepFocus}
        aria-label="Dismiss"
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-secondary"
      >
        <X size={13} />
      </Button>
    </div>
  );
}
