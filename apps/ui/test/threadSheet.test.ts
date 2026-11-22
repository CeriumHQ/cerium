// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { act, createElement as element } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

import type { ShownStatus } from "../src/app/connectionStatus.ts";
import { connectionDetail, runBusy, ThreadSheet, type ThreadSheetProps } from "../src/app/ThreadSheet.tsx";
import { CompactPanelMenu } from "../src/app/Titlebar.tsx";

describe("connectionDetail", () => {
  it("says how each degraded line stands", () => {
    expect(connectionDetail({ kind: "reconnecting" })).toBe("Reconnecting…");
    expect(connectionDetail({ kind: "offline", machine: "studio-mac" })).toBe("Offline");
    expect(connectionDetail({ kind: "offline", machine: "studio-mac", presence: "Last seen 3m ago" })).toBe(
      "Last seen 3m ago",
    );
    expect(connectionDetail({ kind: "cloud", machine: "studio-mac" })).toBe(
      "Cloud copy · messages queue until connected",
    );
    expect(connectionDetail({ kind: "outdated", machine: "studio-mac" })).toBe(
      "Update Cerium on this computer",
    );
    expect(connectionDetail({ kind: "live" })).toBeUndefined();
  });
});

describe("runBusy", () => {
  it("counts the run and any action", () => {
    expect(runBusy(undefined)).toBe(false);
    expect(runBusy({ running: false, onToggle: () => undefined })).toBe(false);
    expect(runBusy({ running: true, onToggle: () => undefined })).toBe(true);
    expect(
      runBusy({ running: false, onToggle: () => undefined, actions: [{ name: "Lint", running: true }] }),
    ).toBe(true);
  });
});

describe("ThreadSheet", () => {
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const text = () => document.body.textContent ?? "";
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find(
      (node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name,
    );
  const base = (patch: Partial<ThreadSheetProps> = {}): ThreadSheetProps => ({
    open: true,
    onOpenChange: () => undefined,
    title: "Fix flaky auth test",
    agents: [],
    panels: {},
    onTogglePanel: () => undefined,
    ...patch,
  });
  const render = (props: ThreadSheetProps) => act(async () => root.render(element(ThreadSheet, props)));

  it("shows the Connection card only while the line is degraded, and retries from it", async () => {
    await render(base({ connectionStatus: { kind: "live" }, onRetry: () => undefined }));
    expect(button("Retry connection")).toBeUndefined();

    vi.useFakeTimers();
    let settle = () => {};
    const onRetry = vi.fn<() => Promise<void>>(() => new Promise<void>((resolve) => (settle = resolve)));
    const onSwitchMachine = vi.fn<() => void>();
    const offline: ShownStatus = { kind: "offline", machine: "studio-mac", presence: "Last seen 3m ago" };
    await render(base({ connectionStatus: offline, onRetry, onSwitchMachine, hasOtherMachines: true }));
    expect(text()).toContain("studio-mac");
    expect(text()).toContain("Last seen 3m ago");
    const retry = button("Retry connection")!;
    expect(retry.textContent).toBe("Retry");
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(retry.textContent).toBe("");
    expect(retry.querySelector(".animate-spin")).not.toBeNull();
    await act(async () => {
      settle();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(retry.textContent).toBe("Retry");

    await act(async () => button("Switch computer")?.click());
    expect(onSwitchMachine).toHaveBeenCalledOnce();
  });

  it("hides Switch computer without another computer", async () => {
    await render(
      base({
        connectionStatus: { kind: "reconnecting" },
        onRetry: () => undefined,
        onSwitchMachine: () => {},
      }),
    );
    expect(text()).toContain("Reconnecting…");
    expect(button("Switch computer")).toBeUndefined();
  });

  it("starts the run and closes, or offers Stop while it runs", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onToggle = vi.fn<() => void>();
    const onAction = vi.fn<(name: string) => void>();
    const onEditActions = vi.fn<() => void>();
    const actions = [
      { name: "Test", running: false },
      { name: "Lint", running: true },
    ];
    await render(base({ onOpenChange, run: { running: false, onToggle, actions, onAction, onEditActions } }));
    expect(text()).toContain("Run");
    await act(async () => button("Run project")?.click());
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    await act(async () => button("Stop Lint")?.click());
    expect(onAction).toHaveBeenLastCalledWith("Lint");
    await act(async () => button("Run Test")?.click());
    expect(onAction).toHaveBeenLastCalledWith("Test");
    await act(async () => button("Edit actions…")?.click());
    expect(onEditActions).toHaveBeenCalledOnce();

    onOpenChange.mockClear();
    await render(base({ onOpenChange, run: { running: true, onToggle } }));
    expect(text()).toContain("Running");
    expect(button("Run project")).toBeUndefined();
    await act(async () => button("Stop run")?.click());
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("offers the panels it has as tiles, toggling one and closing", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const onTogglePanel = vi.fn<(panel: string) => void>();
    const terminal = { open: true, onToggle: vi.fn<() => void>() };
    await render(
      base({
        onOpenChange,
        onTogglePanel,
        terminal,
        preview: { open: false, live: true, onToggle: () => undefined },
        panels: { files: false, git: true },
      }),
    );
    expect(text()).toContain("Panels");
    const tiles = [...document.querySelectorAll("button[aria-pressed]")];
    expect(tiles.map((tile) => tile.textContent)).toEqual(["Terminal", "Preview", "Files", "Git"]);
    expect(tiles.map((tile) => tile.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "true",
    ]);
    expect(tiles[1]?.querySelector(".bg-accent")).not.toBeNull();
    expect(text()).not.toContain("Artifacts");

    await act(async () => button("Git")?.click());
    expect(onTogglePanel).toHaveBeenCalledWith("git");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await act(async () => button("Terminal")?.click());
    expect(terminal.onToggle).toHaveBeenCalledOnce();
  });

  it("opens the agents from their row", async () => {
    const onTogglePanel = vi.fn<(panel: string) => void>();
    await render(base({ agents: ["claude", "codex"], panels: { agents: false }, onTogglePanel }));
    expect(text()).toContain("Agents");
    expect(text()).toContain("2 agents");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((node) => node.textContent?.includes("2 agents"))
        ?.click(),
    );
    expect(onTogglePanel).toHaveBeenCalledWith("agents");
  });
});

describe("CompactPanelMenu", () => {
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
    vi.unstubAllGlobals();
  });

  const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Panels"]');
  const render = (props: Partial<Parameters<typeof CompactPanelMenu>[0]>) =>
    act(async () =>
      root.render(
        element(CompactPanelMenu, { agents: [], panels: {}, onTogglePanel: () => undefined, ...props }),
      ),
    );

  it("opens the sheet in place of its menu", async () => {
    const onOpenSheet = vi.fn<() => void>();
    await render({ onOpenSheet });
    await act(async () => trigger()?.click());
    expect(onOpenSheet).toHaveBeenCalledOnce();
  });

  it("puts a running dot before a live preview's", async () => {
    const preview = { open: false, live: true, onToggle: () => undefined };
    await render({ preview });
    expect(trigger()?.querySelector(".bg-accent")).not.toBeNull();
    await render({ preview, running: true, onOpenSheet: () => undefined });
    expect(trigger()?.querySelector(".bg-running")).not.toBeNull();
    expect(trigger()?.querySelector(".bg-accent")).toBeNull();
  });
});
