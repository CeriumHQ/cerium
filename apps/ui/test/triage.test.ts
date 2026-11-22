// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { act, createElement as element } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

import { laterPresets } from "../src/features/threads/LaterMenu.tsx";
import { LaterSheet } from "../src/features/threads/LaterSheet.tsx";
import { nextWaitingThread, type ThreadSummary } from "../src/features/threads/model.ts";
import { NEXT_PILL_TIMEOUT, NextWaitingPill, offersNext } from "../src/features/threads/NextWaitingPill.tsx";
import { CAUGHT_UP_CLOSE, TriageSheet, triageThreads } from "../src/features/threads/TriageSheet.tsx";

const now = Date.now();
const thread = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  project: "cerium",
  status: "awaitingApproval",
  providers: ["claude"],
  unread: false,
  updatedAt: now,
  ...patch,
});

const threads = [
  thread("a", { updatedAt: now - 1_000 }),
  thread("b", {
    updatedAt: now - 2_000,
    machine: "studio-mac",
    elsewhere: { machine: "dev-1", online: false },
  }),
  thread("idle", { status: "idle", updatedAt: now - 3_000 }),
  thread("c", { updatedAt: now - 4_000 }),
  thread("failed", { status: "failed", unread: true, updatedAt: now - 500 }),
];

describe("triageThreads", () => {
  it("lists only threads waiting on an approval, newest first", () => {
    expect(triageThreads(threads, undefined).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("starts where nextWaitingThread goes and keeps the open thread last", () => {
    const order = triageThreads(threads, "b");
    expect(order.map((t) => t.id)).toEqual(["c", "a", "b"]);
    expect(order[0]?.id).toBe(
      nextWaitingThread(
        threads.filter((t) => t.id !== "failed"),
        "b",
      )?.id,
    );
  });

  it("keeps archived threads that still wait", () => {
    expect(triageThreads([thread("x", { archivedAt: now })], undefined)).toHaveLength(1);
  });
});

describe("offersNext", () => {
  const next = { id: "b", status: "awaitingApproval" as const };
  it("offers the next thread once the open one stops waiting", () => {
    expect(offersNext("awaitingApproval", "running", next, "a")).toBe(true);
  });
  it("offers nothing when it didn't just stop waiting, or none other waits", () => {
    expect(offersNext("running", "idle", next, "a")).toBe(false);
    expect(offersNext("awaitingApproval", "awaitingApproval", next, "a")).toBe(false);
    expect(offersNext("awaitingApproval", "running", undefined, "a")).toBe(false);
    expect(offersNext("awaitingApproval", "running", { id: "b", status: "idle" }, "a")).toBe(false);
    expect(offersNext("awaitingApproval", "running", { ...next, id: "a" }, "a")).toBe(false);
  });
});

describe("sheets and pill", () => {
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

  const buttons = () => [...document.querySelectorAll("button")];
  const text = () => document.body.textContent ?? "";

  it("lists the waiting threads and opens the one tapped", async () => {
    const onOpen = vi.fn<(id: string) => void>();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    await act(async () =>
      root.render(element(TriageSheet, { open: true, onOpenChange, threads, current: "a", onOpen })),
    );
    expect(text()).toContain("Waiting for you");
    expect(text()).toContain("Needs you");
    expect(text()).toContain("studio-mac · Offline");
    const rows = buttons().filter((node) => node.textContent?.includes("Needs you"));
    expect(rows.map((node) => node.querySelector(".truncate")?.textContent)).toEqual(["b", "c", "a"]);
    expect(rows[2]?.getAttribute("aria-current")).toBe("page");
    await act(async () => rows[1]?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpen).toHaveBeenCalledWith("c");
  });

  it("says all caught up once none wait, and closes", async () => {
    vi.useFakeTimers();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const props = { open: true, onOpenChange, current: undefined, onOpen: () => undefined };
    await act(async () => root.render(element(TriageSheet, { ...props, threads })));
    await act(async () => root.render(element(TriageSheet, { ...props, threads: [] })));
    expect(text()).toContain("All caught up.");
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(CAUGHT_UP_CLOSE));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers Later's presets and the custom time", async () => {
    const onPick = vi.fn<(until: number) => void>();
    const onCustom = vi.fn<() => void>();
    await act(async () =>
      root.render(element(LaterSheet, { open: true, onOpenChange: () => undefined, onPick, onCustom })),
    );
    expect(text()).toContain("Move to Later");
    for (const { label } of laterPresets) expect(text()).toContain(label);
    await act(async () =>
      buttons()
        .find((node) => node.textContent?.startsWith("Tomorrow"))
        ?.click(),
    );
    expect(onPick).toHaveBeenCalledWith(laterPresets[2]!.until(Date.now()));
    await act(async () =>
      buttons()
        .find((node) => node.textContent?.includes("Custom date and time"))
        ?.click(),
    );
    expect(onCustom).toHaveBeenCalled();
  });

  it("offers the next waiting thread after the open one's request is answered, then fades", async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn<(id: string) => void>();
    const next = { id: "b", title: "Deploy preview", status: "awaitingApproval" as const };
    const render = (status: ThreadSummary["status"], dismissed = false) =>
      act(async () =>
        root.render(element(NextWaitingPill, { current: { id: "a", status }, next, onOpen, dismissed })),
      );
    const pill = () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Open next waiting thread: Deploy preview"]');

    await render("awaitingApproval");
    expect(pill()).toBeNull();
    await render("running");
    expect(pill()?.textContent).toContain("Next:");
    await act(async () => pill()?.click());
    expect(onOpen).toHaveBeenCalledWith("b");

    await act(async () => vi.advanceTimersByTime(NEXT_PILL_TIMEOUT));
    await act(async () => vi.runAllTimersAsync());
    expect(pill()?.dataset["phase"] ?? "gone").not.toBe("shown");

    await render("awaitingApproval");
    await render("running");
    expect(pill()).not.toBeNull();
    await render("running", true);
    expect(pill()?.dataset["phase"] ?? "gone").not.toBe("shown");
  });
});
