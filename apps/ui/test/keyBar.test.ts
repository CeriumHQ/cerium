// @vitest-environment happy-dom

import { act, createElement as element } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { KeyBar } from "../src/features/terminal/KeyBar.tsx";
import {
  afterKey,
  arrowSequence,
  CTRL_LOCK_MS,
  KEY,
  tapCtrl,
  withCtrl,
} from "../src/features/terminal/keys.ts";
import { TerminalSession } from "../src/features/terminal/session.ts";

describe("key bar sequences", () => {
  it("sends arrows in normal or application cursor form", () => {
    expect(arrowSequence("up", false)).toBe("\x1b[A");
    expect(arrowSequence("down", false)).toBe("\x1b[B");
    expect(arrowSequence("right", true)).toBe("\x1bOC");
    expect(arrowSequence("left", true)).toBe("\x1bOD");
    expect(KEY).toEqual({ escape: "\x1b", tab: "\t", interrupt: "\x03" });
  });

  it("turns a key into its control character, and leaves the rest alone", () => {
    expect(withCtrl("c")).toBe("\x03");
    expect(withCtrl("C")).toBe("\x03");
    expect(withCtrl("a")).toBe("\x01");
    expect(withCtrl("z")).toBe("\x1a");
    expect(withCtrl("[")).toBe("\x1b");
    expect(withCtrl("_")).toBe("\x1f");
    expect(withCtrl("/")).toBe("\x1f");
    expect(withCtrl("?")).toBe("\x7f");
    expect(withCtrl(" ")).toBe("\x00");
    expect(withCtrl("\x1b[A")).toBe("\x1b[1;5A");
    expect(withCtrl("\x1bOD")).toBe("\x1b[1;5D");
    expect(withCtrl("\x1b")).toBe("\x1b");
    expect(withCtrl("|")).toBe("|");
    expect(withCtrl("pasted text")).toBe("pasted text");
  });
});

describe("sticky Ctrl", () => {
  it("latches on a tap and locks on a quick second one", () => {
    expect(tapCtrl("off", 1_000, 0)).toBe("latched");
    expect(tapCtrl("latched", 1_000 + CTRL_LOCK_MS - 1, 1_000)).toBe("locked");
    expect(tapCtrl("latched", 1_000 + CTRL_LOCK_MS + 1, 1_000)).toBe("off");
    expect(tapCtrl("locked", 5_000, 1_000)).toBe("off");
  });

  it("spends a latch on the next key but keeps a lock", () => {
    expect(afterKey("latched")).toBe("off");
    expect(afterKey("locked")).toBe("locked");
    expect(afterKey("off")).toBe("off");
  });
});

describe("TerminalSession input", () => {
  let session: TerminalSession;
  let sent: Array<string>;

  beforeAll(() => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => Promise.resolve([]) },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  beforeEach(() => {
    sent = [];
    session = new TerminalSession({ onInput: (data) => sent.push(data), onSize: () => undefined });
  });

  afterEach(() => session.dispose());

  it("sends raw keys and arrows, through a filter while one is set", () => {
    session.input(KEY.escape);
    session.arrow("up");
    const release = session.filterInput(withCtrl);
    session.input("c");
    session.arrow("left");
    release();
    session.input("c");
    expect(sent).toEqual(["\x1b", "\x1b[A", "\x03", "\x1b[1;5D", "c"]);
  });

  it("sends nothing once the shell has ended", async () => {
    session.end(0);
    await session.ended;
    session.input("x");
    expect(sent).toEqual([]);
  });
});

describe("KeyBar", () => {
  let root: Root;
  let container: HTMLDivElement;
  let sent: Array<string>;
  let pasted: Array<string>;
  let filter: ((data: string) => string) | undefined;
  const session = {
    input: (data: string) => sent.push(filter ? filter(data) : data),
    arrow: (direction: "up" | "down" | "left" | "right") => session.input(arrowSequence(direction, false)),
    paste: (text: string) => pasted.push(text),
    blur: vi.fn<() => void>(),
    focus: () => undefined,
    filterInput: (next: (data: string) => string) => {
      filter = next;
      return () => {
        filter = undefined;
      };
    },
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    sent = [];
    pasted = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = () =>
    act(async () => root.render(element(KeyBar, { session: session as unknown as TerminalSession })));
  const key = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const press = (label: string) => act(async () => key(label).click());

  it("sends its keys without taking focus, and spends a latched Ctrl on the next one", async () => {
    await render();
    for (const label of ["Escape", "Tab", "Interrupt (Ctrl+C)", "|"]) {
      expect(key(label).tabIndex).toBe(-1);
      await press(label);
    }
    expect(sent).toEqual(["\x1b", "\t", "\x03", "|"]);

    await press("Control");
    expect(key("Control").getAttribute("aria-pressed")).toBe("true");
    await press("/");
    await press("_");
    expect(sent.slice(-2)).toEqual(["\x1f", "_"]);
    expect(key("Control").getAttribute("aria-pressed")).toBe("false");

    await press("Control");
    await press("Control");
    expect(key("Control locked")).not.toBeNull();
    await press("~");
    await press("~");
    expect(key("Control locked")).not.toBeNull();

    await press("Hide keyboard");
    expect(session.blur).toHaveBeenCalled();
  });

  it("asks for the text in a sheet when the clipboard can't be read", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.reject(new Error("no")) },
    });
    await render();
    await press("Paste");
    expect(document.body.textContent).toContain("Paste into terminal");
    const field = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Paste here"]')!;
    expect(field).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "echo hi");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = [...document.querySelectorAll("button")].find((each) => each.textContent === "Send")!;
    await act(async () => send.click());
    expect(pasted).toEqual(["echo hi"]);
    Reflect.deleteProperty(navigator, "clipboard");
  });
});
