import type { Rectangle } from "electron";
import type { CdpSession } from "@cerium/browser";
import type { PreviewElement } from "@cerium/browser/inspector";

// Runs on the node resolved by Chromium. Framework metadata is best effort: production builds
// often remove it. Walk DOM ancestors too, as Vue marks component roots, not every descendant.
const describe = String.raw`function(details) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  let component, source;
  const name = t => typeof t === "string" ? t.slice(0, 256) : undefined;
  for (let n = el; n && !component; n = n.parentElement || n.getRootNode().host) {
    const vue = n.__vueParentComponent?.type ?? n.__vue__?.$options;
    if (vue) {
      source = name(vue.__file);
      component = name(vue.name || vue.__name || vue._componentTag) || source?.split("/").pop();
    }
    const key = Object.keys(n).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    const host = n[key];
    for (let f = host, depth = 0; f && depth < 100 && !component; f = f.return, depth++) {
      if (typeof f.type === "string") continue;
      const type = f.type?.render ?? f.type?.type ?? f.type;
      component = name(type?.displayName || type?.name);
      if (component) {
        const loc = host?._debugSource ?? f._debugSource;
        if (loc?.fileName) source = name(loc.fileName + (loc.lineNumber ? ":" + loc.lineNumber : ""));
        else {
          const stack = host?._debugStack?.stack || f._debugStack?.stack;
          source = typeof stack === "string" ? name(stack.split("\n").find(line => /:\d+:\d+/.test(line) && !line.includes("node_modules"))?.trim()) : undefined;
        }
      }
    }
  }
  const r = el.getBoundingClientRect();
  const base = { tag: el.localName, width: Math.round(r.width), height: Math.round(r.height), component, source };
  if (!details) return base;
  const parts = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const root = n.getRootNode();
    if (n.id && root.querySelectorAll("#" + CSS.escape(n.id)).length === 1) {
      parts.unshift("#" + CSS.escape(n.id));
      break;
    }
    const tag = CSS.escape(n.localName);
    const siblings = n.parentElement ? Array.from(n.parentElement.children).filter(s => s.localName === n.localName) : [];
    parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + (siblings.indexOf(n) + 1) + ")" : tag);
  }
  const style = getComputedStyle(el);
  const styles = {};
  for (const key of ["display", "position", "box-sizing", "width", "height", "margin", "padding", "gap", "align-items", "justify-content", "color", "background-color", "border", "border-radius", "font-family", "font-size", "font-weight", "line-height", "text-align", "opacity"]) {
    styles[key] = style.getPropertyValue(key).slice(0, 256);
  }
  return {...base, selector: parts.join(" > ").slice(0, 2048), url: location.href.slice(0, 2048), html: el.outerHTML.slice(0, 4096), styles };
}`;

export const describeNode = async (
  cdp: CdpSession,
  node: { nodeId: number } | { backendNodeId: number },
  details: boolean,
) => {
  const { object } = await cdp.send("DOM.resolveNode", node);
  try {
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: describe,
      arguments: [{ value: details }],
      returnByValue: true,
    });
    if (exceptionDetails || !result.value) throw new Error("The selected element is no longer available.");
    return result.value as PreviewElement;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => undefined);
  }
};

/** The visible part of a node in native view coordinates, including enclosing frame offsets. */
export const captureBounds = async (
  cdp: CdpSession,
  backendNodeId: number,
  fitScale: number,
): Promise<Rectangle> => {
  const [{ model }, { cssVisualViewport: viewport }] = await Promise.all([
    cdp.send("DOM.getBoxModel", { backendNodeId }),
    cdp.send("Page.getLayoutMetrics"),
  ]);
  const quad: number[] = model.border;
  const xs = quad.filter((_, i) => i % 2 === 0).map((x) => x - viewport.offsetX);
  const ys = quad.filter((_, i) => i % 2 === 1).map((y) => y - viewport.offsetY);
  const scale = fitScale * viewport.scale * (viewport.zoom ?? 1);
  const x = Math.max(0, Math.floor(Math.min(...xs) * scale));
  const y = Math.max(0, Math.floor(Math.min(...ys) * scale));
  const width = Math.ceil(Math.min(viewport.clientWidth, Math.max(...xs)) * scale) - x;
  const height = Math.ceil(Math.min(viewport.clientHeight, Math.max(...ys)) * scale) - y;
  if (!(width > 0 && height > 0)) throw new Error("The selected element has moved out of view.");
  return { x, y, width, height };
};
