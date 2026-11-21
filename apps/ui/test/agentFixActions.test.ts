// @vitest-environment happy-dom

import type { ThreadId } from "@cerium/protocol";
import { GitError, type TerminalId, type TerminalInfo } from "@cerium/rpc";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act, createElement, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AskAgentFix } from "../src/features/composer/agentFix.ts";
import { draftText } from "../src/features/composer/draft.ts";
import type { MessageBox } from "../src/features/composer/messageBox.ts";
import { PromptEditor, type PromptEditorHandle } from "../src/features/composer/PromptEditor.tsx";
import { CommitBox } from "../src/features/git/CommitBox.tsx";
import { commitDraftAtom } from "../src/features/git/model.ts";
import { TerminalDrawer } from "../src/features/terminal/TerminalDrawer.tsx";
import { TerminalView } from "../src/features/terminal/TerminalView.tsx";

const rpc = vi.hoisted(() => ({
  terminals: [] as TerminalInfo[],
  commit: vi.fn<(payload: unknown) => GitError>(),
  session: {
    mount: vi.fn<(container: HTMLElement) => () => void>(),
    setTheme: () => undefined,
    onLocalUrl: () => () => undefined,
    hasSelection: vi.fn<() => boolean>(),
    getSelection: vi.fn<() => string>(),
    tailText: vi.fn<() => string>(),
    ended: Promise.resolve<number | undefined>(1),
  },
}));

vi.mock("../src/backend/git.ts", async () => {
  const { Effect } = await import("effect");
  const { Atom } = await import("effect/reactivity");
  return {
    commitChanges: Atom.fn((payload: unknown) => Effect.fail(rpc.commit(payload))),
    draftCommitMessage: Atom.fn(() => Effect.succeed({ message: "Suggestion" })),
    lastCommitMessage: Atom.fn(() => Effect.succeed({ message: "Previous commit" })),
  };
});

vi.mock("../src/backend/terminals.ts", async () => {
  const { Effect } = await import("effect");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    terminalsAtom: Atom.make(() => AsyncResult.success(rpc.terminals)),
    terminalSessionAtom: Atom.family((_key: string) => Atom.make(AsyncResult.success(rpc.session))),
    openTerminal: Atom.fn(() => Effect.void),
    closeTerminal: Atom.fn(() => Effect.void),
    restartTerminal: Atom.fn(() => Effect.void),
  };
});

const terminal: TerminalInfo = {
  id: "terminal" as TerminalId,
  threadId: "thread" as ThreadId,
  shell: "zsh",
  cwd: "/work",
  openedAt: 1,
  run: 1,
};

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let terminalInput: HTMLTextAreaElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  terminalInput = document.createElement("textarea");
  rpc.terminals = [terminal];
  rpc.session.getSelection.mockReset().mockReturnValue("");
  rpc.session.hasSelection.mockReset().mockImplementation(() => rpc.session.getSelection() !== "");
  rpc.session.tailText.mockReset().mockReturnValue("last output");
  rpc.session.mount.mockReset().mockImplementation((container) => {
    container.append(terminalInput);
    return () => terminalInput.remove();
  });
  rpc.session.ended = Promise.resolve(1);
  rpc.commit.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  registry.dispose();
  document.body.replaceChildren();
  delete document.documentElement.dataset["platform"];
});

const interact = (work: () => void) =>
  act(async () => {
    work();
    await Promise.resolve();
  });

const render = (children: ReactNode) =>
  interact(() => root.render(createElement(RegistryContext, { value: registry }, children)));

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`Button not found: ${label}`);
  return found;
}

async function selectionMenu(): Promise<Element> {
  await interact(() => {
    terminalInput.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
  });
  const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((entry) =>
    entry.textContent.startsWith("Send to message box"),
  );
  if (item === undefined) throw new Error("Terminal selection menu item not found");
  return item;
}

describe("terminal selection actions", () => {
  const drawer = (messageBox: Parameters<typeof TerminalDrawer>[0]["messageBox"]) =>
    createElement(TerminalDrawer, {
      owner: { threadId: "thread" },
      chosen: undefined,
      focus: 0,
      compact: false,
      messageBox,
      onAskFix: undefined,
      onChoose: () => undefined,
      onHide: () => undefined,
      onNewFocus: () => undefined,
    });

  it("disables the menu item when the terminal has no selected text", async () => {
    await render(drawer({ append: () => undefined }));
    expect((await selectionMenu()).getAttribute("aria-disabled")).toBe("true");
  });

  it("disables the menu item when the drawer has no composer", async () => {
    rpc.session.getSelection.mockReturnValue("selected");
    await render(drawer(undefined));
    expect((await selectionMenu()).getAttribute("aria-disabled")).toBe("true");
  });

  it("appends a fenced selection to the editor and gives it focus", async () => {
    rpc.session.getSelection.mockReturnValue("\x1b[31mfailure\x1b[0m\n  detail");
    const editor = createRef<PromptEditorHandle>();
    const onChange = vi.fn<Parameters<typeof PromptEditor>[0]["onChange"]>();
    await render([
      createElement(PromptEditor, {
        key: "editor",
        handle: editor,
        resetKey: "draft",
        segments: [{ kind: "text", text: "Please look at this" }],
        placeholder: "Message",
        onChange,
        onTrigger: () => undefined,
        onKeyDown: () => undefined,
        onFiles: () => undefined,
      }),
      createElement(
        "div",
        { key: "terminal" },
        drawer({ append: ({ segments }) => editor.current?.append(segments) }),
      ),
    ]);
    const item = await selectionMenu();
    expect(item.getAttribute("aria-disabled")).toBeNull();
    await interact(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(draftText(onChange.mock.lastCall?.[0] ?? [])).toBe(
      "Please look at this\n```\nfailure\n  detail\n```",
    );
    expect(document.activeElement?.getAttribute("contenteditable")).toBe("true");
  });

  it.each([false, true])("handles the primary modifier shortcut (Mac desktop: %s)", async (mac) => {
    if (mac) document.documentElement.dataset["platform"] = "darwin";
    const append = vi.fn<MessageBox["append"]>();
    await render(drawer({ append }));
    const press = async (modifiers: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", {
        key: "L",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      await interact(() => terminalInput.dispatchEvent(event));
      return event.defaultPrevented;
    };
    const primary = { metaKey: mac, ctrlKey: !mac };
    expect(await press(primary)).toBe(false);
    rpc.session.getSelection.mockReturnValue("selected");
    expect(await press({ metaKey: !mac, ctrlKey: mac })).toBe(false);
    expect(await press(primary)).toBe(true);
    expect(append).toHaveBeenCalledExactlyOnceWith({
      segments: [{ kind: "text", text: "```\nselected\n```" }],
    });
  });
});

describe("failed terminal exits", () => {
  it.each([undefined, 0])("omits the fix action for exit code %s", async (exitCode) => {
    await render(
      createElement(TerminalView, {
        terminal: exitCode === undefined ? terminal : { ...terminal, exitCode },
        focus: 0,
        onError: () => undefined,
        onAskFix: vi.fn<AskAgentFix>().mockResolvedValue("sent"),
      }),
    );
    expect(document.body.textContent).not.toContain("Ask agent to fix");
  });

  it("omits the fix action when there is no recipient", async () => {
    await render(
      createElement(TerminalView, {
        terminal: { ...terminal, exitCode: 1 },
        focus: 0,
        onError: () => undefined,
      }),
    );
    expect(document.body.textContent).not.toContain("Ask agent to fix");
  });

  it("waits for the final terminal output and sends one request per failed run", async () => {
    const finalOutput = Promise.withResolvers<number>();
    rpc.session.ended = finalOutput.promise;
    const delivery = Promise.withResolvers<"sent">();
    const onAskFix = vi.fn<AskAgentFix>(() => delivery.promise);
    const failed = { ...terminal, script: "Tests", exitCode: 23 };
    await render(
      createElement(TerminalView, { terminal: failed, focus: 0, onError: () => undefined, onAskFix }),
    );
    expect(button("Ask agent to fix").disabled).toBe(true);
    await interact(() => finalOutput.resolve(23));
    const ask = button("Ask agent to fix");
    expect(ask.disabled).toBe(false);
    expect(ask.previousElementSibling).toBe(button("Restart"));
    await interact(() => {
      ask.click();
      ask.click();
    });
    expect(button("Sending…").disabled).toBe(true);
    expect(rpc.session.tailText).toHaveBeenCalledTimes(1);
    expect(onAskFix).toHaveBeenCalledExactlyOnceWith(
      "Please investigate and fix this failure.\n\nContext: Tests in /work\nExit code: 23\n\nOutput tail:\n```\nlast output\n```",
    );
    await interact(() => delivery.resolve("sent"));
    expect(button("Sent to agent").disabled).toBe(true);
  });
});

describe("commit failures", () => {
  const failCommit = async (
    failure: { message: string; output?: string },
    onAskFix?: Parameters<typeof CommitBox>[0]["onAskFix"],
  ) => {
    registry.set(commitDraftAtom("/commit-test"), { subject: "Fix lint", body: "", amend: false });
    rpc.commit.mockReturnValueOnce(new GitError(failure));
    await render(
      createElement(CommitBox, {
        top: "/commit-test",
        staged: 1,
        changed: 0,
        conflicted: 0,
        onCommitted: () => undefined,
        onAskFix,
      }),
    );
    await interact(() => button("Commit 1 file").click());
    expect(document.body.textContent).toContain(failure.message);
  };

  it("offers the hook output to the shared fix action, and retries after a delivery error", async () => {
    const onAskFix = vi
      .fn<AskAgentFix>()
      .mockRejectedValueOnce(new Error("Agent is offline"))
      .mockResolvedValueOnce("draft");
    await failCommit(
      { message: "The pre-commit hook stopped the commit.", output: "\x1b[31mLint failed\x1b[0m" },
      onAskFix,
    );
    expect(document.body.textContent).toContain("What the hook printed");
    await interact(() => button("Ask agent to fix").click());
    expect(document.querySelector('span[role="alert"]')?.textContent).toBe("Agent is offline");
    expect(onAskFix).toHaveBeenCalledExactlyOnceWith(
      "Please investigate and fix this failure.\n\nCommand: git commit\nContext: /commit-test\nFailure: The pre-commit hook stopped the commit.\n\nOutput tail:\n```\nLint failed\n```",
    );
    await interact(() => button("Ask agent to fix").click());
    expect(button("Added to message box").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Agent is offline");
  });

  it.each([
    { message: "Git refused the commit.", output: "some output" },
    { message: "The commit-msg hook stopped the commit." },
  ])("offers a fix for $message", async (failure) => {
    await failCommit(failure, vi.fn<AskAgentFix>().mockResolvedValue("sent"));
    expect(button("Ask agent to fix").disabled).toBe(false);
  });

  it.each([{ message: "Git refused the commit.", output: " " }, { message: "Git refused the commit." }])(
    "omits the fix action for a plain failure without output ($output)",
    async (failure) => {
      await failCommit(failure, vi.fn<AskAgentFix>().mockResolvedValue("sent"));
      expect(document.body.textContent).not.toContain("Ask agent to fix");
    },
  );

  it("omits the hook fix action when there is no recipient", async () => {
    await failCommit({ message: "The pre-commit hook stopped the commit.", output: "Lint failed" });
    expect(document.body.textContent).not.toContain("Ask agent to fix");
  });
});
