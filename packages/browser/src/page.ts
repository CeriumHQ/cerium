import { Cdp, CdpError } from "./cdp.ts";

// One driven page: finding elements, acting on them like a user, and reading back what is on screen.
// Page-side helpers are plain JavaScript strings, so a bundler can never rewrite what runs in the page.

/** Where an action lands: visible text or an accessible name, a CSS selector, or a point. */
export interface Target {
  readonly text?: string | undefined;
  readonly selector?: string | undefined;
  /** Which match, counting from 0 in page order, when several fit. */
  readonly nth?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}

export interface Found {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly matches: number;
}

export interface ConsoleEntry {
  readonly level: string;
  readonly text: string;
}

const HELPERS = String.raw`
if (!window.__ceriumUi) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const interactive = 'a[href],button,input,textarea,select,summary,label,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    // Visually hidden form inputs (a select's value, say) are a pixel square.
    if (r.width < 2 || r.height < 2 || el.closest("[aria-hidden=true]")) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.01;
  };
  const names = (el) => {
    const out = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder"), el.getAttribute("alt")];
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) out.push(el.value);
    out.push(el.innerText);
    return out.filter((n) => n !== null && n !== undefined && String(n).trim() !== "");
  };
  const roleOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return el.type === "checkbox" || el.type === "radio" ? el.type : "textbox";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  const describe = (el) => {
    const name = names(el)[0];
    return roleOf(el) + (name ? ' "' + String(name).replace(/\s+/g, " ").trim().slice(0, 60) + '"' : "");
  };
  const candidates = (target) => {
    if (target.selector) return [...document.querySelectorAll(target.selector)].filter(visible);
    const want = norm(target.text);
    let scored = [];
    for (const el of document.querySelectorAll("body *")) {
      let score = 0;
      for (const n of names(el)) {
        const v = norm(n);
        if (v === want) score = 2;
        else if (score === 0 && v.includes(want)) score = 1;
      }
      if (score > 0 && visible(el)) scored.push({ el, score, inter: el.matches(interactive) });
    }
    const best = Math.max(0, ...scored.map((c) => c.score));
    scored = scored.filter((c) => c.score === best);
    // Text inside a button belongs to the button; of nested matches the innermost is the one meant.
    scored = scored.filter((c) => c.inter || !scored.some((d) => d !== c && d.inter && d.el.contains(c.el)));
    scored = scored.filter((c) => !scored.some((d) => d !== c && c.el.contains(d.el)));
    return scored.map((c) => c.el);
  };
  window.__ceriumUi = {
    find(target) {
      const all = candidates(target);
      const el = all[target.nth ?? 0];
      if (!el) return { matches: all.length };
      const r0 = el.getBoundingClientRect();
      if (r0.top < 0 || r0.left < 0 || r0.bottom > innerHeight || r0.right > innerWidth) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }
      const r = el.getBoundingClientRect();
      window.__ceriumUi.last = el;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, label: describe(el), matches: all.length };
    },
    inspect(withText) {
      const seen = new Set();
      const elements = [];
      for (const el of document.querySelectorAll(interactive + ",h1,h2,h3,h4,h5,h6,[role=dialog],[role=alertdialog],[role=alert],[role=status],[role=tooltip],[role=menu],[role=listbox]")) {
        if (elements.length >= 150) break;
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        const item = { role: roleOf(el), name: String(names(el)[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 80), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
        const states = [];
        if (el.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
        if (el.checked || el.getAttribute("aria-checked") === "true") states.push("checked");
        if (el.getAttribute("aria-expanded") === "true") states.push("expanded");
        if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) states.push("selected");
        if (document.activeElement === el) states.push("focused");
        if (states.length) item.states = states;
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) item.value = el.value.slice(0, 80);
        elements.push(item);
      }
      const result = { url: location.href, title: document.title, viewport: [innerWidth, innerHeight], scroll: [Math.round(scrollX), Math.round(scrollY)], elements };
      if (withText) result.text = (document.body?.innerText ?? "").slice(0, 6000);
      return result;
    },
  };
}
`;

const MODIFIERS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string | undefined;
  readonly modifiers: number;
}

/** `Enter`, `Control+Shift+K`, `Shift+Tab`, `a`, `F5` as one key press with its modifier bits. */
export const parseKeys = (combo: string): KeyPress => {
  const parts = combo.split("+").map((part) => part.trim());
  // "Control++" presses the plus key.
  const last = combo.endsWith("++") ? "+" : (parts.pop() ?? "");
  let modifiers = 0;
  for (const part of parts) {
    if (part === "") continue;
    const bit = MODIFIERS[part.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${part}" in "${combo}".`);
    modifiers |= bit;
  }
  const named = NAMED_KEYS[last.toLowerCase()];
  if (named) return { ...named, modifiers };
  const fn = /^f([1-9]|1[0-2])$/i.exec(last);
  if (fn)
    return { key: last.toUpperCase(), code: last.toUpperCase(), keyCode: 111 + Number(fn[1]), modifiers };
  if (!/^.$/su.test(last)) throw new Error(`Unknown key "${last}" in "${combo}".`);
  const upper = last.toUpperCase();
  const letter = /^[A-Z]$/.test(upper);
  const digit = /^[0-9]$/.test(last);
  return {
    key: last,
    code: letter ? `Key${upper}` : digit ? `Digit${last}` : "",
    keyCode: letter || digit ? upper.charCodeAt(0) : 0,
    // A shortcut types nothing; Shift alone still types its character.
    ...((modifiers & ~MODIFIERS["shift"]!) === 0 ? { text: last } : {}),
    modifiers,
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long an action gives its target to show, as a user waits for a control to appear. */
const ACTION_WAIT_MS = 5_000;

/** `Page.settle` in the page; endless animations (spinners) are left running. */
const SETTLE = String.raw`new Promise((resolve) => {
  if (document.visibilityState === "hidden") return resolve(false);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ending = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
    Promise.race([
      Promise.all(ending.map((a) => a.finished.catch(() => undefined))),
      new Promise((done) => setTimeout(done, 1000)),
    ]).then(() => resolve(true));
  }));
})`;

/** The left button held down between `down` and `up`, and the native drag it started, if any. */
interface Held {
  x: number;
  y: number;
  native?: unknown;
  entered: boolean;
  readonly stop: () => void;
}

export class Page {
  private readonly console: Array<ConsoleEntry> = [];
  private held: Held | undefined;
  private front = false;
  readonly cdp: Cdp;

  private constructor(cdp: Cdp) {
    this.cdp = cdp;
    const push = (entry: ConsoleEntry) => {
      this.console.push({ level: entry.level, text: entry.text.slice(0, 500) });
      if (this.console.length > 100) this.console.shift();
    };
    cdp.on("Runtime.consoleAPICalled", (event) =>
      push({
        level: event.type,
        text: (event.args ?? [])
          .map((arg: any) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type)))
          .join(" "),
      }),
    );
    cdp.on("Runtime.exceptionThrown", (event) =>
      push({
        level: "exception",
        text:
          event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "Uncaught error",
      }),
    );
    cdp.on("Page.javascriptDialogOpening", (event) => {
      push({ level: "dialog", text: `${event.type}: ${event.message} (accepted)` });
      void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
    });
  }

  /**
   * With `front`, for a browser this tool launched, a page another tab or a popup hid is brought back
   * before each step: a hidden page answers input events after 5 s and screenshots never.
   */
  static async open(webSocketUrl: string, options: { readonly front?: boolean } = {}): Promise<Page> {
    const page = new Page(await Cdp.connect(webSocketUrl));
    page.front = options.front ?? false;
    await Promise.all([page.cdp.send("Page.enable"), page.cdp.send("Runtime.enable")]);
    if (page.front) await page.bringBack();
    return page;
  }

  /**
   * Whether the page is on screen. A hidden page, or a window Windows minimized (and parked far
   * off-screen), draws a frame a second or none, so each input event and screenshot takes seconds.
   */
  async shown(): Promise<boolean> {
    return this.evaluate<boolean>('document.visibilityState === "visible" && screenX > -10000').catch(
      () => false,
    );
  }

  private async bringBack(): Promise<void> {
    if ((await this.evaluate("document.visibilityState")) === "hidden")
      await this.cdp.send("Page.bringToFront");
  }

  get closed(): boolean {
    return this.cdp.closed;
  }

  close(): void {
    this.cdp.close();
  }

  /** Console messages, uncaught errors and dialogs since the last call. */
  drainConsole(): ReadonlyArray<ConsoleEntry> {
    return this.console.splice(0);
  }

  async evaluate<T = unknown>(expression: string, timeoutMs = 15_000): Promise<T> {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new CdpError(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "The script threw.",
      );
    }
    return result.result?.value as T;
  }

  private helper<T>(call: string): Promise<T> {
    return this.evaluate<T>(`${HELPERS}\n${call}`);
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = this.cdp.once("Page.loadEventFired", timeoutMs);
    const result = await this.cdp.send("Page.navigate", { url }, timeoutMs);
    if (result.errorText) throw new CdpError(`Could not open ${url}: ${result.errorText}.`);
    await loaded;
    await this.settle();
  }

  async reload(timeoutMs = 30_000): Promise<void> {
    const loaded = this.cdp.once("Page.loadEventFired", timeoutMs);
    await this.cdp.send("Page.reload");
    await loaded;
    await this.settle();
  }

  async back(): Promise<void> {
    await this.evaluate("history.back()");
    await sleep(300);
    await this.settle();
  }

  /**
   * Lets the page paint what the last action changed: a short pause, two animation frames, then the
   * animations and transitions it started, up to a second. A page left hidden (minimized, say) draws
   * no frames, so it gets the pause alone.
   */
  async settle(ms = 120): Promise<void> {
    await sleep(ms);
    if (this.front) await this.bringBack().catch(() => undefined);
    await this.evaluate(SETTLE, 2_000).catch(() => undefined);
  }

  async viewport(options: {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly mobile: boolean;
  }): Promise<void> {
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.scale,
      mobile: options.mobile,
    });
    await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: options.mobile, maxTouchPoints: 5 });
  }

  async colorScheme(scheme: "light" | "dark"): Promise<void> {
    await this.cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  }

  /** Finds the target, scrolling it into view; fails naming what it looked for. */
  async find(target: Target): Promise<Found> {
    if (target.x !== undefined && target.y !== undefined) {
      return {
        x: target.x,
        y: target.y,
        width: 0,
        height: 0,
        label: `point ${target.x},${target.y}`,
        matches: 1,
      };
    }
    if (target.text === undefined && target.selector === undefined) {
      throw new CdpError("Name a target: text, selector, or x and y.");
    }
    const found = await this.helper<Partial<Found> & { matches: number }>(
      `window.__ceriumUi.find(${JSON.stringify(target)})`,
    );
    if (found.x === undefined) {
      const what = target.selector !== undefined ? `selector ${target.selector}` : `"${target.text}"`;
      throw new CdpError(
        found.matches === 0
          ? `Nothing visible matches ${what}.`
          : `Only ${found.matches} visible match ${what}; nth ${target.nth} is past the end.`,
      );
    }
    return found as Found;
  }

  /** `find` for an action: gives the target up to `ACTION_WAIT_MS` to show before failing. */
  private async locate(target: Target): Promise<Found> {
    if (target.x === undefined) {
      await this.waitFor(target, { gone: false, timeoutMs: ACTION_WAIT_MS }).catch(() => undefined);
    }
    return this.find(target);
  }

  /** Waits until the target shows, or with `gone` until it no longer does. */
  async waitFor(
    target: Target,
    options: { readonly gone: boolean; readonly timeoutMs: number },
  ): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const found = await this.find(target).then(
        () => true,
        (error: unknown) => {
          if (error instanceof CdpError && /^Nothing visible|^Only/.test(error.message)) return false;
          throw error;
        },
      );
      if (found !== options.gone) return;
      if (Date.now() > deadline) {
        const what = target.selector ?? `"${target.text}"`;
        throw new CdpError(
          `${what} ${options.gone ? "is still showing" : "never showed"} after ${options.timeoutMs / 1000} s.`,
        );
      }
      await sleep(150);
    }
  }

  async click(
    target: Target,
    options: { readonly button: "left" | "right" | "middle"; readonly count: number },
  ): Promise<Found> {
    const found = await this.locate(target);
    const buttons = { left: 1, right: 2, middle: 4 }[options.button];
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y });
    for (let click = 1; click <= options.count; click++) {
      const event = { x: found.x, y: found.y, button: options.button, buttons, clickCount: click };
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...event });
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...event, buttons: 0 });
    }
    return found;
  }

  async hover(target: Target): Promise<Found> {
    const found = await this.locate(target);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y });
    return found;
  }

  /** Whether a `down` is still waiting for its `up`. */
  get holding(): boolean {
    return this.held !== undefined;
  }

  /**
   * Presses the left button on the target and keeps it down. A native (HTML5) drag the page starts
   * is intercepted, so `move` and `up` can carry it to a drop with its data: headless input alone
   * never runs one.
   */
  async down(target: Target): Promise<Found> {
    if (this.held !== undefined) throw new CdpError("The button is already down; `up` first.");
    const found = await this.locate(target);
    await this.cdp.send("Input.setInterceptDrags", { enabled: true });
    const held: Held = {
      x: found.x,
      y: found.y,
      entered: false,
      stop: this.cdp.on("Input.dragIntercepted", (event) => (held.native = event.data)),
    };
    this.held = held;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: found.x,
      y: found.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    return found;
  }

  /** Moves the held button to the target in small steps, over whatever the page shows on the way. */
  async move(target: Target): Promise<Found> {
    const held = this.held;
    if (held === undefined) throw new CdpError("Nothing is held; `down` first.");
    const end = await this.locate(target);
    for (let step = 1; step <= 10; step++) {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: held.x + ((end.x - held.x) * step) / 10,
        y: held.y + ((end.y - held.y) * step) / 10,
        button: "left",
        buttons: 1,
      });
    }
    held.x = end.x;
    held.y = end.y;
    // The page answers the first moves with dragstart; its interception arrives a moment later.
    if (held.native === undefined) await sleep(50);
    if (held.native !== undefined) {
      const at = { x: end.x, y: end.y, data: held.native };
      if (!held.entered) await this.cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...at });
      held.entered = true;
      await this.cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...at });
    }
    return end;
  }

  /** Lets go where the pointer is: the drop of a native drag, a plain release otherwise. */
  async up(): Promise<void> {
    const held = this.held;
    if (held === undefined) throw new CdpError("Nothing is held; `down` first.");
    this.held = undefined;
    held.stop();
    if (held.native !== undefined) {
      await this.cdp.send("Input.dispatchDragEvent", {
        type: "drop",
        x: held.x,
        y: held.y,
        data: held.native,
      });
    }
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: held.x,
      y: held.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await this.cdp.send("Input.setInterceptDrags", { enabled: false });
  }

  async drag(from: Target, to: Target): Promise<void> {
    await this.down(from);
    await this.move(to);
    await this.up();
  }

  /** Types into the focused element, or clicks `into` first to focus it. */
  async type(text: string, into?: Target, clear = false): Promise<void> {
    if (into !== undefined) await this.click(into, { button: "left", count: 1 });
    if (clear) {
      await this.evaluate(
        `(() => { const el = document.activeElement; if (!el) return;
          if ("value" in el) { el.select?.(); } else { const range = document.createRange(); range.selectNodeContents(el);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); } })()`,
      );
      await this.press(parseKeys("Delete"));
    }
    await this.cdp.send("Input.insertText", { text });
  }

  async press(key: KeyPress): Promise<void> {
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers: key.modifiers,
    };
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: key.text === undefined ? "rawKeyDown" : "keyDown",
      ...base,
      ...(key.text === undefined ? {} : { text: key.text, unmodifiedText: key.text }),
    });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async scroll(deltaX: number, deltaY: number, at?: Target): Promise<void> {
    const point = at !== undefined ? await this.locate(at) : await this.center();
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
    });
    await sleep(250);
  }

  private async center(): Promise<{ x: number; y: number }> {
    const [width, height] = await this.evaluate<[number, number]>("[innerWidth, innerHeight]");
    return { x: width / 2, y: height / 2 };
  }

  /** Puts files in a file input, as if the user picked them. */
  async upload(selector: string, files: ReadonlyArray<string>): Promise<void> {
    const handle = await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    const objectId = handle.result?.objectId;
    if (objectId === undefined) throw new CdpError(`No element matches ${selector}.`);
    await this.cdp.send("DOM.setFileInputFiles", { files, objectId });
  }

  async inspect(withText: boolean): Promise<unknown> {
    return this.helper(`window.__ceriumUi.inspect(${withText})`);
  }

  /** A PNG of the viewport, the whole page, or one element. */
  async screenshot(options: {
    readonly fullPage: boolean;
    readonly of?: Target | undefined;
  }): Promise<Uint8Array> {
    await this.settle(60);
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (options.of !== undefined) {
      const found = await this.locate(options.of);
      const pad = 8;
      const box = await this.evaluate<{ x: number; y: number }>("({ x: scrollX, y: scrollY })");
      clip = {
        x: Math.max(0, found.x - found.width / 2 - pad + box.x),
        y: Math.max(0, found.y - found.height / 2 - pad + box.y),
        width: found.width + pad * 2,
        height: found.height + pad * 2,
        scale: 1,
      };
    } else if (options.fullPage) {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.min(Math.ceil(size.height), 16_000),
        scale: 1,
      };
    }
    const shot = await this.cdp.send(
      "Page.captureScreenshot",
      { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) },
      30_000,
    );
    return Buffer.from(shot.data as string, "base64");
  }
}
