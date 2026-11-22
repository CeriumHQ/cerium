import { localUrlsIn } from "@cerium/browser/url";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IBuffer, type ITheme } from "@xterm/xterm";

import { usesCommandKey } from "../../lib/keys.ts";
import { currentBinding, matchesBinding } from "../../lib/shortcuts.ts";
import { lastText, OUTPUT_TAIL_CHARS, OUTPUT_TAIL_LINES } from "../composer/agentFix.ts";
import { openLocally } from "../preview/model.ts";
import { isOpenableLink } from "../transcript/menus.ts";
import { arrowSequence, type Arrow } from "./keys.ts";
import { readTheme } from "./theme.ts";

// One terminal's emulator on this side: xterm.js, kept for as long as the terminal is in use rather
// than as long as the drawer shows it, so switching threads or tabs finds the screen and scrollback
// as they were. It knows nothing of the backend; whoever owns it feeds `write` and takes `onInput`.
// It draws with xterm's DOM renderer: the WebGL one paints italic text over a black box once the
// background is clear, and the drawer's glass needs it clear.

/**
 * Red Hat Mono first, as the conversation's code is set. Prompts such as oh-my-posh and Starship draw
 * their symbols from a Nerd Font, which the page falls back to glyph by glyph: whichever of the usual
 * ones is installed supplies them, in its one-cell "Mono" cut.
 */
const FONT_FAMILY = [
  '"Red Hat Mono Variable"',
  '"Symbols Nerd Font Mono"',
  '"MesloLGM Nerd Font Mono"',
  '"MesloLGS Nerd Font Mono"',
  '"MesloLGS NF"',
  '"CaskaydiaMono Nerd Font Mono"',
  '"CaskaydiaCove Nerd Font Mono"',
  '"JetBrainsMono Nerd Font Mono"',
  '"FiraCode Nerd Font Mono"',
  '"Hack Nerd Font Mono"',
  '"Cascadia Mono"',
  "ui-monospace",
  "monospace",
].join(", ");
/**
 * The conversation's code is 12.5px under the page's font-size-adjust, which scales Red Hat to an
 * x-height of 0.53 em from its own 0.488; the emulator measures its own cells, so it is given that size.
 */
const FONT_SIZE = 13.5;
const SCROLLBACK = 5_000;
/** The least time between two fits while the terminal's container is resized. */
const FIT_MS = 80;
/** How long the visible part of the page holds still before a phone's keyboard counts as settled. */
const KEYBOARD_SETTLE_MS = 120;

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

export interface SessionOptions {
  /** The Windows build whose ConPTY runs the shell, which wraps lines itself. */
  readonly windowsBuild?: number | undefined;
  /** What the user typed or pasted. */
  readonly onInput: (data: string) => void;
  /** The terminal's size changed, as its container did. */
  readonly onSize: (size: Size) => void;
}

const isWindows = () => /win/i.test(navigator.platform);

let lastFitted: Size = { cols: 100, rows: 20 };

/** The size a terminal was last fitted to, which a new one opens at, to draw its first prompt at the width it will have. */
export const fittedSize = (): Size => lastFitted;

/** Puts text on the clipboard; the page's clipboard needs a secure context, so a plain-http one falls back. */
export const copyToClipboard = (text: string): void => {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
};

/** Reads logical lines from the bottom of a buffer, including scrollback beyond the viewport. */
function bufferTailText(buffer: IBuffer, cols: number, maxLines: number, maxChars: number): string {
  const lines: string[] = [];
  let remaining = Math.floor(maxChars);
  let current = "";
  let nextWraps = false;
  let nextStartsWide = false;
  for (let row = buffer.length - 1; row >= 0 && lines.length < Math.floor(maxLines) && remaining > 0; row--) {
    const line = buffer.getLine(row);
    if (line === undefined) continue;
    // A wide character that didn't fit leaves an unused cell at the right edge before wrapping.
    const gap = nextWraps && nextStartsWide && line.getCell(cols - 1)?.getChars() === "";
    const text = line.translateToString(current === "", 0, cols - Number(gap));
    current = (text + current).trimEnd();
    if (current.length > remaining) {
      const tail = lastText(current, remaining);
      if (tail !== "") lines.push(tail);
      break;
    }
    if ((!line.isWrapped || row === 0) && current !== "") {
      lines.push(current);
      remaining -= current.length + 1;
      current = "";
    }
    nextWraps = line.isWrapped;
    nextStartsWide = line.isWrapped && line.getCell(0)?.getWidth() === 2;
  }
  return lines.reverse().join("\n");
}

export class TerminalSession {
  readonly terminal: Terminal;
  /** What the emulator draws into; moved between containers as the drawer shows this terminal. */
  readonly host: HTMLDivElement;
  readonly #fit = new FitAddon();
  #opened = false;
  #disposed = false;
  #ended = false;
  /** Called once the emulator has a size from its container for the first time. */
  #onFirstFit: (() => void) | undefined;
  /** Settles when the emulator first has a size from a container, so output can be drawn at it. */
  readonly sized: Promise<void>;
  /** Settles once the shell's final output is drawn, or when the terminal closes (no code). */
  readonly ended: Promise<number | undefined>;
  #onEnded: ((code: number | undefined) => void) | undefined;
  /** The font is loaded: the emulator measures its cells with it, so it opens only then. */
  #fontLoaded = false;
  readonly #font: Promise<unknown>;
  readonly #onInput: (data: string) => void;
  /** Rewrites what's typed before the shell gets it: the key bar's latched Ctrl. */
  #inputFilter: ((data: string) => string) | undefined;

  constructor(options: SessionOptions) {
    this.host = document.createElement("div");
    this.host.className = "terminal-host h-full w-full";
    this.terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "none",
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.3,
      scrollback: SCROLLBACK,
      // Option types the Mac's own characters (`#`, `@`, `[` on many layouts), as in Terminal.app.
      macOptionIsMeta: false,
      smoothScrollDuration: 0,
      theme: readTheme(),
      ...(options.windowsBuild === undefined
        ? {}
        : { windowsPty: { backend: "conpty" as const, buildNumber: options.windowsBuild } }),
    });
    this.terminal.loadAddon(this.#fit);
    this.terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        // A dev server's local address opens in the thread's preview, where the desktop app has one.
        if (openLocally(uri)) return;
        if (isOpenableLink(uri)) window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    this.#onInput = options.onInput;
    this.terminal.onData((data) => this.#send(data));
    this.terminal.onResize(({ cols, rows }) => options.onSize({ cols, rows }));
    this.terminal.attachCustomKeyEventHandler((event) => this.#keyHandled(event));

    // The window's own shortcuts (Ctrl K, Ctrl N, …) are keys the shell uses too: inside the terminal
    // they are the shell's, but for the one that shows and hides the terminal and returning focus to
    // the message box. On a Mac they take ⌘, which no shell reads, so they stay the window's.
    this.host.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.code === "Backquote") return;
      if (matchesBinding(event, currentBinding("focus-composer"), usesCommandKey())) return;
      if (usesCommandKey() && event.metaKey) return;
      event.stopPropagation();
    });
    this.sized = new Promise((resolve) => {
      this.#onFirstFit = resolve;
    });
    this.ended = new Promise((resolve) => {
      this.#onEnded = resolve;
    });
    this.#font = document.fonts.load(`${FONT_SIZE}px "Red Hat Mono Variable"`).then(
      () => {
        this.#fontLoaded = true;
      },
      () => {
        this.#fontLoaded = true;
      },
    );
  }

  /** Whether the emulator hands the key to the window instead of the shell. */
  #keyHandled(event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;
    // ⌘ keys on a Mac are the app's: ⌘C and ⌘V copy and paste through the Edit menu, and the rest
    // are the window's shortcuts.
    if (usesCommandKey() && event.metaKey) return false;
    if (matchesBinding(event, currentBinding("focus-composer"), usesCommandKey())) return false;
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
    const key = event.key.toLowerCase();
    // The window shows and hides the terminal with it.
    if (ctrl && event.code === "Backquote") return false;
    if (ctrl && event.shiftKey && key === "c") {
      this.copySelection();
      event.preventDefault();
      return false;
    }
    // Pasting is the browser's: the clipboard event reaches the emulator, which pastes (bracketed, if
    // the shell asked).
    if (ctrl && event.shiftKey && key === "v") return false;
    if (ctrl && !event.shiftKey && key === "v" && isWindows()) return false;
    // Ctrl C copies what's selected and otherwise interrupts, as Windows Terminal does.
    if (ctrl && !event.shiftKey && key === "c" && this.terminal.hasSelection()) {
      this.copySelection();
      this.terminal.clearSelection();
      event.preventDefault();
      return false;
    }
    return true;
  }

  /** Shows the emulator in `container`, fitted to it; returns how to let go of it. */
  mount(container: HTMLElement): () => void {
    if (this.#disposed) return () => undefined;
    container.append(this.host);
    const show = () => {
      if (this.#disposed || !this.host.isConnected) return;
      if (!this.#opened) {
        this.#opened = true;
        this.terminal.open(this.host);
      }
      this.fit();
    };
    if (this.#fontLoaded) show();
    else void this.#font.then(show);
    // Each fit to a new width reflows the whole scrollback and resizes the shell's screen, so while the
    // container is being resized the emulator is fitted at most every FIT_MS, and once more as it stops.
    let pause: ReturnType<typeof setTimeout> | undefined;
    let again = false;
    const refit = () => {
      if (pause !== undefined) {
        again = true;
        return;
      }
      this.fit();
      pause = setTimeout(() => {
        pause = undefined;
        if (!again) return;
        again = false;
        refit();
      }, FIT_MS);
    };
    // A phone's keyboard sliding in or out resizes the container every frame: the shell is fitted
    // once, after the visible part of the page has held still for KEYBOARD_SETTLE_MS.
    let moving: ReturnType<typeof setTimeout> | undefined;
    const viewport = matchMedia("(pointer: coarse)").matches ? window.visualViewport : null;
    const onViewport = () => {
      clearTimeout(moving);
      moving = setTimeout(() => {
        moving = undefined;
        refit();
      }, KEYBOARD_SETTLE_MS);
    };
    viewport?.addEventListener("resize", onViewport);
    const observer = new ResizeObserver(() => {
      if (moving === undefined) refit();
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", onViewport);
      clearTimeout(pause);
      clearTimeout(moving);
      this.host.remove();
    };
  }

  /** Fits the emulator to its container, if it has room. */
  fit() {
    const parent = this.host.parentElement;
    if (
      this.#disposed ||
      !this.#opened ||
      parent === null ||
      parent.clientWidth === 0 ||
      parent.clientHeight === 0
    )
      return;
    this.#fit.fit();
    lastFitted = this.size();
    this.#onFirstFit?.();
    this.#onFirstFit = undefined;
  }

  size(): Size {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  write(data: string) {
    if (this.#disposed) return;
    this.terminal.write(data);
    this.#watchForLocalUrl(data);
  }

  /** The tail of the output, so an address split between two writes is still found. */
  #tail = "";
  #localUrl: string | undefined;
  readonly #localUrlListeners = new Set<() => void>();

  /** The last local address the terminal printed, such as a dev server's `Local: http://localhost:5173/`. */
  get localUrl(): string | undefined {
    return this.#localUrl;
  }

  /** Calls back when the terminal prints another local address; returns how to stop. */
  onLocalUrl(listener: () => void): () => void {
    this.#localUrlListeners.add(listener);
    return () => this.#localUrlListeners.delete(listener);
  }

  #watchForLocalUrl(data: string) {
    // Colours and cursor moves come out first: a dev server colours its port apart from its host.
    const text = `${this.#tail}${data}`.replace(
      // oxlint-disable-next-line no-control-regex -- escape sequences are control characters
      /\u001b\[[\d;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g,
      "",
    );
    this.#tail = text.slice(-200);
    if (!text.includes("://")) return;
    const found = localUrlsIn(text).at(-1);
    if (found === undefined || found === this.#localUrl) return;
    this.#localUrl = found;
    for (const listener of this.#localUrlListeners) listener();
  }

  /** Clears the screen and its scrollback, to draw a screen the backend sends afresh. */
  reset() {
    if (!this.#disposed) this.terminal.reset();
  }

  /** The shell ended: nothing more can be typed into it, and its cursor goes. */
  end(code?: number) {
    if (this.#ended || this.#disposed) return;
    this.#ended = true;
    this.terminal.write("\x1b[?25l", () => {
      this.#onEnded?.(code);
      this.#onEnded = undefined;
    });
  }

  setTheme(theme: ITheme = readTheme()) {
    if (!this.#disposed) this.terminal.options.theme = theme;
  }

  focus() {
    if (!this.#disposed) this.terminal.focus();
  }

  /** Lets go of the cursor, which puts a phone's keyboard away. */
  blur() {
    if (!this.#disposed) this.terminal.blur();
  }

  #send(data: string) {
    if (this.#ended || this.#disposed) return;
    this.#onInput(this.#inputFilter === undefined ? data : this.#inputFilter(data));
  }

  /** Sends keys to the shell as typed ones, raw: an escape, a tab, an arrow's sequence. */
  input(data: string) {
    if (this.#ended || this.#disposed) return;
    this.terminal.scrollToBottom();
    this.#send(data);
  }

  /** Sends an arrow key, in the form the shell asked for (application cursor keys or not). */
  arrow(direction: Arrow) {
    this.input(arrowSequence(direction, this.terminal.modes.applicationCursorKeysMode));
  }

  /** Rewrites everything typed until the returned function is called. */
  filterInput(filter: (data: string) => string): () => void {
    this.#inputFilter = filter;
    return () => {
      if (this.#inputFilter === filter) this.#inputFilter = undefined;
    };
  }

  hasFocus(): boolean {
    return this.host.contains(document.activeElement);
  }

  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  getSelection(): string {
    return this.terminal.getSelection().trim();
  }

  tailText(maxLines = OUTPUT_TAIL_LINES, maxChars = OUTPUT_TAIL_CHARS): string {
    return bufferTailText(this.terminal.buffer.active, this.terminal.cols, maxLines, maxChars);
  }

  copySelection() {
    const text = this.terminal.getSelection();
    if (text !== "") copyToClipboard(text);
  }

  paste(text: string) {
    if (!this.#ended && !this.#disposed) this.terminal.paste(text);
  }

  selectAll() {
    this.terminal.selectAll();
  }

  clear() {
    this.terminal.clear();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onEnded?.(undefined);
    this.#onEnded = undefined;
    this.host.remove();
    this.terminal.dispose();
  }
}
