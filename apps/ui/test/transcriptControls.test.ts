// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { act, createElement as element, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

import { SideQuestion, type AskSide } from "../src/features/composer/SideQuestion.tsx";
import { MessageBoxContext, type MessageBox } from "../src/features/composer/messageBox.ts";
import { SelectionReply } from "../src/features/transcript/SelectionReply.tsx";
import { TurnChanges, type TurnFileActions } from "../src/features/transcript/TurnChanges.tsx";
import type { TurnChanges as Changes } from "../src/features/transcript/model.ts";

vi.mock("../src/features/transcript/Markdown.tsx", () => ({
  Markdown: ({ text }: { text: string }) => text,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
});

const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find(
    (node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label,
  );

const select = async (node: HTMLElement | null) => {
  if (!node) throw new Error("Missing selection source");
  await act(async () => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
};

const press = (node: HTMLElement, key: string) =>
  act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

const write = (field: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });

const quote = "First line\nSecond line";
const askLabel = "Ask /btw about the selected passage";

function SelectionFixture({ ask }: { ask?: AskSide }) {
  const [within] = useState(() => createRef<HTMLDivElement>());
  const [composer] = useState(() => createRef<HTMLTextAreaElement>());
  const [side, setSide] = useState<{ id: number; open: boolean; quote?: string }>();
  const box: MessageBox = {
    mention: () => undefined,
    append: () => undefined,
    comment: () => undefined,
    openSide: (draft) => setSide((was) => ({ ...draft, id: (was?.id ?? 0) + 1, open: true })),
    key: () => "thread",
  };
  return element(
    MessageBoxContext,
    { value: box },
    element(
      "div",
      { ref: within },
      element("p", { "data-reply-source": "" }, quote),
      element("p", { id: "user" }, "User message"),
    ),
    element(SelectionReply, {
      within,
      onOpenSideQuestion: ask && ((selected: string) => box.openSide({ quote: selected })),
    }),
    element("textarea", { "aria-label": "Message", ref: composer }),
    element("button", { type: "button", onClick: () => box.openSide() }, "Open side question"),
    side && ask
      ? element(SideQuestion, {
          key: side.id,
          open: side.open,
          quote: side.quote,
          anchor: composer,
          finalFocus: composer,
          ask,
          onClose: () => setSide({ id: side.id, open: false }),
        })
      : null,
  );
}

describe("selection side questions", () => {
  it("only offers Ask /btw for a selected agent response when the thread can open a side question", async () => {
    await act(async () => root.render(element(SelectionFixture)));
    await select(container.querySelector("[data-reply-source]"));
    expect(button("Reply")).toBeDefined();
    expect(button(askLabel)).toBeUndefined();

    await act(async () => root.render(element(SelectionFixture, { ask: async () => "Answer" })));
    await select(container.querySelector("#user"));
    expect(button(askLabel)).toBeUndefined();
    await select(container.querySelector("[data-reply-source]"));
    expect(button(askLabel)).toBeDefined();
    expect(button("Reply")).toBeDefined();
  });

  it("opens with the passage and input focus, submits on Enter, and preserves the quote in follow-up context", async () => {
    const ask = vi.fn<AskSide>().mockResolvedValue("An answer");
    await act(async () => root.render(element(SelectionFixture, { ask })));
    await select(container.querySelector("[data-reply-source]"));
    await act(async () => button(askLabel)?.click());

    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Question"]');
    if (!field) throw new Error("Missing question input");
    const quoteId = field.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(quoteId)?.textContent).toBe(quote);
    await vi.waitFor(() => expect(document.activeElement).toBe(field));
    await press(field, "Enter");
    expect(ask).not.toHaveBeenCalled();

    await write(field, "Why this approach?");
    await press(field, "Enter");
    const question = "About this passage:\n\n> First line\n> Second line\n\nWhy this approach?";
    expect(ask).toHaveBeenCalledExactlyOnceWith(question, []);
    expect(
      [...document.querySelectorAll("p")].some((node) => node.textContent === "Why this approach?"),
    ).toBe(true);

    await write(field, "What's the alternative?");
    await press(field, "Enter");
    expect(ask).toHaveBeenNthCalledWith(2, "What's the alternative?", [{ question, answer: "An answer" }]);

    await press(field, "Escape");
    const composer = container.querySelector('textarea[aria-label="Message"]');
    await vi.waitFor(() => expect(document.activeElement).toBe(composer));
    expect(document.querySelector("blockquote")).toBeNull();

    await act(async () => button("Open side question")?.click());
    expect(document.querySelector('textarea[aria-label="Question"]')).not.toBeNull();
    expect(document.querySelector("blockquote")).toBeNull();
    expect(ask).toHaveBeenCalledTimes(2);

    await act(async () => button("Close")?.click());
    await select(container.querySelector("[data-reply-source]"));
    await act(async () => button(askLabel)?.click());
    expect(document.querySelector("blockquote")?.textContent).toBe(quote);
    await act(async () => button("Close")?.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(composer));
    expect(document.querySelector("blockquote")).toBeNull();
  });

  it("still immediately asks an initial /btw question", async () => {
    const ask = vi.fn<AskSide>().mockResolvedValue("An answer");
    const anchor = { current: container };
    await act(async () =>
      root.render(
        element(SideQuestion, {
          open: true,
          anchor,
          finalFocus: anchor,
          initial: "Early question",
          ask,
          onClose: () => undefined,
        }),
      ),
    );
    expect(ask).toHaveBeenCalledExactlyOnceWith("Early question", []);
  });
});

describe("turn file controls", () => {
  const changes: Changes = {
    turnId: "t1",
    before: "before",
    after: "after",
    more: 0,
    files: [
      { path: "src/a.ts", change: "modified", via: "edit" },
      { path: "src/b.ts", change: "added", via: "edit" },
    ],
  };

  it("opens the diff separately and undoes or redoes just the selected file", async () => {
    const open = vi.fn<TurnFileActions["open"]>();
    const pending = Promise.withResolvers<boolean>();
    const revert = vi
      .fn<TurnFileActions["revert"]>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(true);
    const actions = { open, revert, perFile: true };
    await act(async () => root.render(element(TurnChanges, { changes, actions })));

    const diff = container.querySelector<HTMLButtonElement>('button[title="src/a.ts"]');
    const undo = button("Undo src/a.ts");
    expect(undo?.parentElement).toBe(diff?.parentElement);
    await act(async () => diff?.click());
    expect(open).toHaveBeenCalledExactlyOnceWith({ before: "before", after: "after", path: "src/a.ts" });
    await act(async () => undo?.click());
    expect(revert).toHaveBeenCalledExactlyOnceWith("t1", "undone", ["src/a.ts"]);
    expect(undo?.disabled).toBe(true);
    expect(button("Undo src/b.ts")?.disabled).toBe(true);
    expect(button("Undo")?.disabled).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(true));

    const partial: Changes = {
      ...changes,
      status: "partial",
      fileStates: new Map([["src/a.ts", { undone: true, kept: false, turnUndone: true }]]),
    };
    await act(async () => root.render(element(TurnChanges, { changes: partial, actions })));
    expect(container.textContent).toContain("Partially undone");
    await act(async () => button("Redo src/a.ts")?.click());
    expect(revert).toHaveBeenNthCalledWith(2, "t1", "redone", ["src/a.ts"]);
    await act(async () => button("Undo")?.click());
    expect(revert).toHaveBeenNthCalledWith(3, "t1", "undone", undefined);

    const fullyUndone: Changes = {
      ...changes,
      status: "undone",
      fileStates: new Map(
        changes.files.map(({ path }) => [path, { undone: true, kept: false, turnUndone: true }]),
      ),
    };
    await act(async () => root.render(element(TurnChanges, { changes: fullyUndone, actions })));
    await act(async () => button("Redo")?.click());
    expect(revert).toHaveBeenNthCalledWith(4, "t1", "redone", undefined);
  });

  it("keeps the legacy whole-turn action and hides per-file actions for read-only turns", async () => {
    const actions = { open: () => undefined, revert: async () => true, perFile: false };
    await act(async () => root.render(element(TurnChanges, { changes, actions })));
    expect(button("Undo src/a.ts")).toBeUndefined();
    expect(button("Undo")).toBeDefined();
    await act(async () => root.render(element(TurnChanges, { changes, actions: undefined })));
    expect(button("Undo src/a.ts")).toBeUndefined();
    expect(button("Undo")).toBeUndefined();
  });
});
