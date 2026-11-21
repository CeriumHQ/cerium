// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TerminalSession } from "../src/features/terminal/session.ts";

let session: TerminalSession;

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
  session = new TerminalSession({ onInput: () => undefined, onSize: () => undefined });
});

afterEach(() => session.dispose());

describe("TerminalSession.tailText", () => {
  it("reads the last non-empty logical lines from scrollback, ignoring unused screen rows", async () => {
    session.terminal.resize(10, 3);
    session.write("discard\r\nfirst  \r\n\r\nsecond \r\n\r\nlast  \r\n");
    session.end(1);
    await expect(session.ended).resolves.toBe(1);
    expect(session.tailText(2)).toBe("second\nlast");
    expect(session.tailText(10)).toBe("discard\nfirst\nsecond\nlast");
  });

  it("joins wrapped rows and keeps spaces printed at the wrap boundary", async () => {
    session.terminal.resize(8, 4);
    session.write("older\r\nfoo bar baz  \r\nend");
    session.end(1);
    await session.ended;
    expect(session.tailText(2)).toBe("foo bar baz\nend");
    expect(session.tailText(2, 8)).toBe(" baz\nend");
    expect(session.tailText(0)).toBe("");
    expect(session.tailText(2, 0)).toBe("");
  });

  it("keeps wide characters without including wrap padding or cutting a surrogate pair", async () => {
    session.terminal.resize(5, 3);
    session.write("abcd字😀Z");
    session.end(1);
    await session.ended;
    expect(session.tailText(1)).toBe("abcd字😀Z");
    expect(session.tailText(1, 3)).toBe("😀Z");
    expect(session.tailText(1, 2)).toBe("Z");
  });

  it("reads the active alternate buffer when the terminal exits there", async () => {
    session.write("normal buffer\x1b[?1049h\x1b[H\x1b[31malternate buffer\x1b[0m");
    session.end(1);
    await session.ended;
    expect(session.tailText()).toBe("alternate buffer");
  });
});

describe("TerminalSession.getSelection", () => {
  it("returns trimmed text or an empty string", () => {
    const selection = vi.spyOn(session.terminal, "getSelection");
    selection.mockReturnValue(" \nselected\n  detail\n ");
    expect(session.getSelection()).toBe("selected\n  detail");
    selection.mockReturnValue(" \n ");
    expect(session.getSelection()).toBe("");
  });
});
