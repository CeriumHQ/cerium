import { describe, expect, it } from "@effect/vitest";

import { clampWidth, INSPECTOR, panelLayout, SIDEBAR } from "../src/app/panelLayout.ts";

const defaults = { sidebar: SIDEBAR.fallback, inspector: INSPECTOR.fallback };

describe("clampWidth", () => {
  it("keeps a width between its bounds, the minimum winning when the room is short", () => {
    expect(clampWidth(100, 232, 420)).toBe(232);
    expect(clampWidth(300, 232, 420)).toBe(300);
    expect(clampWidth(900, 232, 420)).toBe(420);
    expect(clampWidth(300, 232, 100)).toBe(232);
  });
});

describe("panelLayout", () => {
  it("puts the inspector beside the transcript in a roomy window", () => {
    const layout = panelLayout(1440, defaults, true);
    expect(layout.floating).toBe(false);
    expect(layout.sidebarWidth).toBe(278);
    expect(layout.inspectorWidth).toBe(320);
  });

  it("floats the inspector once the transcript would be squeezed", () => {
    expect(panelLayout(960, defaults, true).floating).toBe(true);
    // Folding the sidebar gives the room back.
    expect(panelLayout(960, defaults, false).floating).toBe(false);
  });

  it("offers to fold the sidebar when that is what lets the panel sit beside the transcript", () => {
    // An 800 px window: 748 px of body, which a sidebar, a transcript and a panel can't share.
    const narrow = panelLayout(748, defaults, true);
    expect(narrow.floating).toBe(true);
    expect(narrow.foldsSidebar).toBe(true);
    const folded = panelLayout(748, defaults, false);
    expect(folded.floating).toBe(false);
    expect(folded.foldsSidebar).toBe(false);
    expect(748 - folded.sidebarSpace - 12 - folded.inspectorWidth).toBeGreaterThanOrEqual(400);
    // A roomy window keeps its sidebar, and one too narrow for any panel beside a transcript floats it.
    expect(panelLayout(1440, defaults, true).foldsSidebar).toBe(false);
    const cramped = panelLayout(600, defaults, true);
    expect(cramped.floating).toBe(true);
    expect(cramped.foldsSidebar).toBe(false);
  });

  it("never lets the sidebar take more than 40% of the window or a width the user couldn't drag to", () => {
    expect(panelLayout(1000, { ...defaults, sidebar: 420 }, true).sidebarWidth).toBe(400);
    expect(panelLayout(1440, { ...defaults, sidebar: 100 }, true).sidebarWidth).toBe(SIDEBAR.min);
    expect(panelLayout(2400, { ...defaults, sidebar: 900 }, true).sidebarWidth).toBe(SIDEBAR.max);
  });

  it("takes only the gutter for a folded sidebar", () => {
    expect(panelLayout(1440, defaults, false).sidebarSpace).toBe(6);
    expect(panelLayout(1440, defaults, true).sidebarSpace).toBe(278);
  });

  it("limits a wide inspector to what leaves the transcript its room", () => {
    const layout = panelLayout(1440, { ...defaults, inspector: 560 }, true);
    expect(layout.inspectorWidth).toBe(layout.inspectorMax);
    expect(1440 - layout.sidebarSpace - 12 - layout.inspectorWidth).toBeGreaterThanOrEqual(480);
  });
});
