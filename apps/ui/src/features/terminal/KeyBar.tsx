import type { TerminalInfo } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

import { terminalSessionAtom } from "../../backend/terminals.ts";
import { Button } from "../../components/ui/Button.tsx";
import { Sheet } from "../../components/ui/Sheet.tsx";
import { useKeyboardOpen } from "../../web/viewport.ts";
import {
  afterKey,
  KEY,
  REPEAT_DELAY_MS,
  REPEAT_EVERY_MS,
  tapCtrl,
  withCtrl,
  type Arrow,
  type Ctrl,
} from "./keys.ts";
import type { TerminalSession } from "./session.ts";

const keyClass =
  "relative grid h-8 min-w-10 shrink-0 cursor-default place-items-center rounded-lg px-2.5 font-mono text-[13px] outline-none select-none [touch-action:manipulation] transition-[background-color,color,box-shadow,scale] duration-100 active:scale-[0.96] motion-reduce:active:scale-100";
const plainKey = "bg-surface-raised text-fg-primary shadow-raised active:bg-surface-active";
const ctrlLook: Record<Ctrl, string> = {
  off: `${plainKey} duration-150 ease-in-soft`,
  latched: "bg-accent-soft text-accent-text ring-1 ring-accent/40 ring-inset",
  locked: "bg-accent text-accent-fg shadow-button",
};

/** Keeps the cursor in the terminal, so a key's tap doesn't put the phone's keyboard away. */
const keepFocus = (event: PointerEvent) => event.preventDefault();

const vibrate = (ms: number) => navigator.vibrate?.(ms);

const Divider = () => <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line-subtle" />;

function Key({
  label,
  onPress,
  className = plainKey,
  pressed,
  children,
}: {
  label: string;
  onPress: () => void;
  className?: string;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      onPointerDown={keepFocus}
      onClick={onPress}
      className={`${keyClass} ${className}`}
    >
      {children}
    </button>
  );
}

/** An arrow, which repeats while held. */
function ArrowKey({ label, icon: Icon, onPress }: { label: string; icon: LucideIcon; onPress: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stop = () => {
    clearTimeout(timer.current);
    clearInterval(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        stop();
        onPress();
        timer.current = setTimeout(() => {
          vibrate(5);
          onPress();
          timer.current = setInterval(onPress, REPEAT_EVERY_MS);
        }, REPEAT_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      // A click without a pointer (assistive technology) presses it once.
      onClick={(event) => {
        if (event.detail === 0) onPress();
      }}
      className={`${keyClass} ${plainKey}`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
    </button>
  );
}

const ARROWS: ReadonlyArray<readonly [Arrow, string, LucideIcon]> = [
  ["left", "Left arrow", ArrowLeft],
  ["down", "Down arrow", ArrowDown],
  ["up", "Up arrow", ArrowUp],
  ["right", "Right arrow", ArrowRight],
];

const SYMBOLS = ["|", "~", "/", "-", "_"] as const;

/**
 * The keys a phone's keyboard lacks, on a bar that sits on top of it under the terminal: Esc, Tab, a
 * sticky Ctrl, Ctrl C, the arrows, paste and the symbols a shell wants, with the keyboard's own
 * button to put it away pinned at the end. No key takes focus, so the keyboard stays up.
 */
export function KeyBar({ session }: { session: TerminalSession }) {
  const keyboardOpen = useKeyboardOpen();
  const [ctrl, setCtrl] = useState<Ctrl>("off");
  /** Ctrl as the next key finds it, ahead of the render that shows it. */
  const ctrlNow = useRef<Ctrl>("off");
  const lastCtrlTap = useRef(0);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const changeCtrl = (next: Ctrl) => {
    ctrlNow.current = next;
    setCtrl(next);
  };

  // While Ctrl is on, whatever is typed next, on the bar or the keyboard, goes with it.
  useEffect(
    () =>
      session.filterInput((data) => {
        const state = ctrlNow.current;
        if (state === "off") return data;
        ctrlNow.current = afterKey(state);
        setCtrl(ctrlNow.current);
        return withCtrl(data);
      }),
    [session],
  );

  const send = (data: string) => session.input(data);

  const paste = () => {
    const fallback = () => {
      setPasted("");
      setPasting(true);
    };
    const reading = navigator.clipboard?.readText?.();
    if (reading === undefined) return fallback();
    reading.then((text) => session.paste(text), fallback);
  };

  return (
    <div
      data-key-bar=""
      className={`flex shrink-0 items-stretch border-t border-line-subtle bg-surface-panel backdrop-blur-2xl ${keyboardOpen ? "pb-0" : "pb-[env(safe-area-inset-bottom)]"}`}
    >
      <div
        role="toolbar"
        aria-label="Terminal keys"
        className="flex h-11 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pl-2 [mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-16px),transparent)] [scrollbar-width:none]"
      >
        <Key label="Escape" onPress={() => send(KEY.escape)}>
          esc
        </Key>
        <Key label="Tab" onPress={() => send(KEY.tab)}>
          tab
        </Key>
        <Key
          label={ctrl === "locked" ? "Control locked" : "Control"}
          pressed={ctrl !== "off"}
          className={ctrlLook[ctrl]}
          onPress={() => {
            const now = performance.now();
            changeCtrl(tapCtrl(ctrlNow.current, now, lastCtrlTap.current));
            lastCtrlTap.current = now;
          }}
        >
          ctrl
          {ctrl === "locked" ? (
            <span
              aria-hidden="true"
              className="absolute bottom-1 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-current"
            />
          ) : null}
        </Key>
        <Key label="Interrupt (Ctrl+C)" onPress={() => send(KEY.interrupt)}>
          ^C
        </Key>
        <Divider />
        {ARROWS.map(([direction, label, icon]) => (
          <ArrowKey key={direction} label={label} icon={icon} onPress={() => session.arrow(direction)} />
        ))}
        <Divider />
        <Key label="Paste" onPress={paste} className={`${plainKey} font-sans`}>
          paste
        </Key>
        <Divider />
        {SYMBOLS.map((symbol) => (
          <Key key={symbol} label={symbol} onPress={() => send(symbol)}>
            {symbol}
          </Key>
        ))}
        <span aria-hidden="true" className="w-2 shrink-0" />
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Hide keyboard"
        onPointerDown={keepFocus}
        onClick={() => session.blur()}
        className="grid size-11 shrink-0 cursor-default place-items-center border-l border-line-subtle text-fg-secondary outline-none select-none active:bg-surface-active"
      >
        <ChevronDown size={18} strokeWidth={1.75} aria-hidden />
      </button>
      <Sheet
        open={pasting}
        onOpenChange={setPasting}
        title="Paste into terminal"
        footer={
          <Button
            tone="primary"
            className="w-full"
            disabled={pasted === ""}
            onClick={() => {
              session.paste(pasted);
              setPasting(false);
              session.focus();
            }}
          >
            Send
          </Button>
        }
      >
        <div className="px-1 pt-1">
          <textarea
            aria-label="Paste into terminal"
            value={pasted}
            rows={4}
            placeholder="Paste here"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setPasted(event.target.value)}
            className="block max-h-60 min-h-24 w-full resize-none rounded-xl border border-line-subtle bg-surface-raised px-3 py-2.5 font-mono text-[15px] text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary focus:border-line-strong"
          />
        </div>
      </Sheet>
    </div>
  );
}

/** The key bar for the terminal `terminal`, while its shell runs. */
export function TerminalKeyBar({ terminal }: { terminal: TerminalInfo }) {
  const result = useAtomValue(terminalSessionAtom(`${terminal.id}:${terminal.run}`));
  const session = AsyncResult.isSuccess(result) ? result.value : undefined;
  if (session === undefined || terminal.exitCode !== undefined) return null;
  return <KeyBar session={session} />;
}
