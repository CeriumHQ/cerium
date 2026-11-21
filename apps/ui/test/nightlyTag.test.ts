import { RegistryProvider } from "@effect/atom-react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CompactBar } from "../src/app/CompactBar.tsx";
import { Titlebar } from "../src/app/Titlebar.tsx";
import { CeriumBrand } from "../src/components/CeriumBrand.tsx";
import { NightlyTag, nightlyLabel, nightlyVersion } from "../src/features/updates/NightlyTag.tsx";

// The version the UI was built with, which each test sets. The web build draws no caption buttons,
// so the titlebar renders without a document.
const build = vi.hoisted(() => ({ version: "dev" }));
vi.mock("../src/backend/target.ts", () => ({
  WEB: true,
  get BUILD_VERSION() {
    return build.version;
  },
}));

const NIGHTLY = "0.18.0-nightly.n000292";

const render = (node: ReactNode, version: string) => {
  build.version = version;
  return renderToStaticMarkup(createElement(RegistryProvider, null, node));
};

const titlebar = ({
  withoutThread,
  ...props
}: {
  alone?: boolean;
  bare?: boolean;
  sidebarOpen?: boolean;
  page?: string;
  tabs?: ReactNode;
  withoutThread?: boolean;
}) =>
  createElement(Titlebar, {
    mode: "work",
    sidebarOpen: props.sidebarOpen ?? true,
    sidebarWidth: 278,
    resizing: false,
    onToggleSidebar: () => undefined,
    onNewThread: () => undefined,
    agents: [],
    panels: {},
    onTogglePanel: () => undefined,
    ...(withoutThread ? {} : { thread: { title: "Fix the login flow", project: "app" } }),
    ...props,
  });

const tags = (html: string) => html.match(/data-nightly=""/g)?.length ?? 0;
const mark = (html: string) => html.match(/<span\b[^>]*data-nightly=""[^>]*>.*?<\/span>/)?.[0] ?? "";

describe("nightlyVersion", () => {
  it("is the updater's version on a nightly build", () => {
    expect(nightlyVersion({ buildChannel: "nightly", version: NIGHTLY }, "dev")).toBe(NIGHTLY);
  });

  it("is absent on a stable build, whichever channel the UI was built for", () => {
    expect(nightlyVersion({ buildChannel: "stable", version: "0.18.0" }, NIGHTLY)).toBeUndefined();
    expect(nightlyVersion({ buildChannel: "stable", version: "0.18.0" }, "0.18.0")).toBeUndefined();
  });

  it("falls back to the build's own version without an updater, as on the web", () => {
    expect(nightlyVersion(undefined, NIGHTLY)).toBe(NIGHTLY);
    expect(nightlyVersion(undefined, "0.18.0")).toBeUndefined();
    expect(nightlyVersion(undefined, "dev")).toBeUndefined();
  });
});

describe("nightlyLabel", () => {
  it("names the exact build", () => {
    expect(nightlyLabel(NIGHTLY)).toBe("Cerium Nightly · v0.18.0-nightly.n000292");
  });

  it("doesn't double a leading v", () => {
    expect(nightlyLabel(`v${NIGHTLY}`)).toBe("Cerium Nightly · v0.18.0-nightly.n000292");
  });
});

describe("NightlyTag", () => {
  it("shows a plain text edition mark on a nightly build", () => {
    const html = render(createElement(NightlyTag), NIGHTLY);
    expect(tags(html)).toBe(1);
    expect(html).toMatch(/^<span[^>]*>NIGHTLY<\/span>$/);
    expect(html).not.toMatch(/\b(?:rounded|border|bg-|px-)/);
    expect(html).toContain("text-fg-tertiary");
    expect(html).toContain("hover:text-fg-secondary");
    // Clear of the window's drag region, so its tooltip shows on hover.
    expect(html).toContain("[app-region:no-drag]");
  });

  it("uses superscript alignment", () => {
    const html = render(createElement(NightlyTag), NIGHTLY);
    expect(mark(html)).toContain("-translate-y-1");
    expect(mark(html)).not.toContain("self-center");
  });

  it("draws nothing on a stable build or in development", () => {
    expect(render(createElement(NightlyTag), "0.18.0")).toBe("");
    expect(render(createElement(NightlyTag), "dev")).toBe("");
  });

  it("keeps the brand itself unchanged", () => {
    expect(tags(render(createElement(CeriumBrand), NIGHTLY))).toBe(0);
  });
});

describe("the titlebar", () => {
  const states = [
    { name: "with the sidebar open", props: {}, title: "Fix the login flow" },
    { name: "with the sidebar folded", props: { sidebarOpen: false }, title: "Fix the login flow" },
    { name: "in a thread's own window", props: { alone: true }, title: "Fix the login flow" },
    { name: "over Settings", props: { page: "Settings", bare: true }, title: "Settings" },
    { name: "over GitHub", props: { page: "GitHub" }, title: "GitHub" },
    { name: "with tabs", props: { tabs: createElement("span", null, "Thread tab") }, title: "Thread tab" },
    { name: "without a selected thread", props: { withoutThread: true }, title: undefined },
  ];

  it.each(states)("raises the mark beside the brand $name", ({ props, title }) => {
    const html = render(titlebar(props), NIGHTLY);
    expect(tags(html)).toBe(1);
    expect(mark(html)).toContain("-translate-y-1");
    expect(html).toContain('max-lg:hidden">cerium</span>');
    expect(html.indexOf("data-nightly")).toBeGreaterThan(html.indexOf("cerium</span>"));
    expect(html.indexOf("data-nightly")).toBeLessThan(
      html.indexOf(title === undefined ? "</header>" : `>${title}<`),
    );
  });

  it.each(states)("omits the mark on stable and dev $name", ({ props }) => {
    expect(tags(render(titlebar(props), "0.18.0"))).toBe(0);
    expect(tags(render(titlebar(props), "dev"))).toBe(0);
  });
});

describe("the compact bar", () => {
  const back = { label: "Threads", onBack: () => undefined };
  const brand = { leading: createElement(CeriumBrand) };
  const thread = {
    back,
    title: "Fix the login flow",
    subtitle: "app",
    trailing: createElement("button", { type: "button" }, "Panels"),
  };
  const settings = { back, title: "Settings" };
  const page = { back: { ...back, label: "GitHub" } };
  const folded = { ...thread, folded: true };

  it.each([
    { name: "in a list pane", props: brand },
    { name: "in the thread pane", props: thread },
    { name: "in Settings", props: settings },
    { name: "on a page with only a back label", props: page },
    { name: "while folded", props: folded },
  ])("omits the mark on nightly builds $name", ({ props }) => {
    const html = render(createElement(CompactBar, props), NIGHTLY);
    expect(tags(html)).toBe(0);
    expect(html).not.toContain("NIGHTLY");
  });

  it.each([brand, thread, settings, page, folded])("omits the mark on stable and dev", (props) => {
    expect(tags(render(createElement(CompactBar, props), "0.18.0"))).toBe(0);
    expect(tags(render(createElement(CompactBar, props), "dev"))).toBe(0);
  });
});
