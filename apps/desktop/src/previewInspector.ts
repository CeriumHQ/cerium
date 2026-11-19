import type { Rectangle, WebContents } from "electron";
import type { CdpSession } from "@cerium/browser";
import {
  viewportWidths,
  type PreviewElement,
  type PreviewInspectorState,
  type PreviewIssue,
  type PreviewTheme,
  type PreviewViewport,
} from "@cerium/browser/inspector";

import { captureBounds, describeNode } from "./previewElement.ts";

let nextIssue = 0;

/** Bound to the very same debugger attachment as the agents' Page. */
export class PreviewInspector {
  private picking = false;
  private hover: string | undefined;
  private error: string | undefined;
  private document = 0;
  private hovered = 0;
  private viewport: PreviewViewport = "fit";
  private theme: PreviewTheme = "system";
  private issues: PreviewIssue[] = [];

  private readonly contents: WebContents;
  private readonly cdp: CdpSession;
  private readonly size: () => { width: number; height: number };
  private readonly changed: () => void;
  private readonly selected: (element: PreviewElement, png: string) => void;

  constructor(
    cdp: CdpSession,
    contents: WebContents,
    size: () => { width: number; height: number },
    changed: () => void,
    selected: (element: PreviewElement, png: string) => void,
  ) {
    this.cdp = cdp;
    this.contents = contents;
    this.size = size;
    this.changed = changed;
    this.selected = selected;
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (frame.parentId) return;
      this.document++;
      this.issues = [];
      this.error = undefined;
      this.cancel();
      this.changed();
    });
    cdp.on("Overlay.inspectModeCanceled", () => this.cancel());
    cdp.on("Overlay.nodeHighlightRequested", ({ nodeId }) => {
      if (!this.picking) return;
      const version = ++this.hovered;
      void describeNode(cdp, { nodeId }, false)
        .then((node) => {
          if (!this.picking || version !== this.hovered) return;
          this.hover = [node.tag, `${node.width} × ${node.height}`, node.component, node.source]
            .filter(Boolean)
            .join(" · ");
          this.changed();
        })
        .catch(() => undefined); // The pointer may already have left a detached node.
    });
    cdp.on("Overlay.inspectNodeRequested", ({ backendNodeId }) => {
      if (!this.picking) return;
      const doc = this.document;
      void this.pick(backendNodeId, doc).catch((error: unknown) => {
        if (doc !== this.document) return;
        this.error = error instanceof Error ? error.message : "Couldn't capture the element.";
        this.changed();
      });
    });
  }

  get state(): PreviewInspectorState {
    return {
      picking: this.picking,
      viewport: this.viewport,
      theme: this.theme,
      issueCount: this.issues.length,
      ...(this.hover ? { hover: this.hover } : {}),
      ...(this.error ? { inspectorError: this.error } : {}),
    };
  }

  readonly addIssue = (text: string) => {
    this.issues.push({ id: ++nextIssue, text: text.slice(0, 3000) });
    if (this.issues.length > 32) this.issues.shift();
    this.changed();
  };

  snapshot() {
    return this.issues.slice();
  }

  acknowledge(last: number) {
    this.issues = this.issues.filter((issue) => issue.id > last);
    this.changed();
  }

  async setTheme(theme: PreviewTheme) {
    await this.cdp.send("Emulation.setEmulatedMedia", {
      features: theme === "system" ? [] : [{ name: "prefers-color-scheme", value: theme }],
    });
    this.theme = theme;
    this.changed();
  }

  private scale(viewport: PreviewViewport) {
    const width = viewportWidths[viewport];
    return width === undefined ? 1 : Math.min(1, this.size().width / width);
  }

  async resize(viewport = this.viewport) {
    const width = viewportWidths[viewport];
    if (width === undefined) {
      if (this.viewport !== "fit") await this.cdp.send("Emulation.clearDeviceMetricsOverride");
    } else {
      const size = this.size();
      const scale = this.scale(viewport);
      await this.cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: Math.max(1, Math.round(size.height / scale)),
        deviceScaleFactor: 1,
        mobile: false,
        scale,
      });
    }
  }

  async setViewport(viewport: PreviewViewport) {
    await this.resize(viewport);
    this.viewport = viewport;
    this.changed();
  }

  cancel() {
    if (this.picking) void this.setPicking(false).catch(() => undefined);
  }

  async setPicking(enabled: boolean) {
    this.error = undefined;
    this.hover = undefined;
    this.hovered++;
    this.picking = enabled;
    try {
      if (enabled) {
        await this.cdp.send("DOM.enable");
        await this.cdp.send("DOM.getDocument", { depth: 0 });
        await this.cdp.send("Overlay.enable");
        if (!this.picking) return;
      }
      await this.cdp.send("Overlay.setInspectMode", {
        mode: enabled ? "searchForNode" : "none",
        highlightConfig: {
          showInfo: true,
          showAccessibilityInfo: false,
          contentColor: { r: 76, g: 155, b: 220, a: 0.3 },
          borderColor: { r: 46, g: 125, b: 200, a: 0.8 },
        },
      });
    } catch (error) {
      this.picking = false;
      throw error;
    } finally {
      this.changed();
    }
  }

  private async pick(backendNodeId: number, doc: number) {
    // Keep the toolbar's hint in place until the crop is taken: removing it resizes the view.
    this.picking = false;
    this.hover = undefined;
    try {
      await this.cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
      const element = await describeNode(this.cdp, { backendNodeId }, true);
      const bounds = await captureBounds(this.cdp, backendNodeId, this.scale(this.viewport));
      const png = await this.capture(bounds);
      if (doc === this.document) this.selected(element, png);
    } finally {
      this.changed();
    }
  }

  private async capture(bounds: Rectangle) {
    const image = await this.contents.capturePage(bounds);
    if (image.isEmpty()) throw new Error("Couldn't capture the selected element.");
    const { width, height } = image.getSize();
    const fitted =
      Math.max(width, height) <= 800
        ? image
        : image.resize(width >= height ? { width: 800 } : { height: 800 });
    return fitted.toPNG({ scaleFactor: 1 }).toString("base64");
  }
}
