import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { CopyButton } from "./CopyButton.tsx";

// Mermaid diagrams in a reply. Mermaid is large, so it loads the first time a reply has a diagram and
// costs nothing before. A diagram is drawn once its code fence closes (a placeholder holds its place
// while it streams, so the reply never shows a half-written diagram), in the window's own colours,
// and again when the theme changes. One that doesn't parse stays as its source.

type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | undefined;
const loadMermaid = (): Promise<Mermaid> => {
  loading ??= import("mermaid").then((module) => module.default);
  return loading;
};

/** Changes to the mode, the palette or the desktop's colours, which together decide the window's colours. */
const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["data-theme", "data-palette", "data-desktop"],
  });
  return () => observer.disconnect();
};

/** What a diagram is drawn with: Mermaid's theme variables, and the font. */
interface DiagramTheme {
  readonly variables: Readonly<Record<string, string>>;
  readonly font: string;
}

/**
 * `tokens` (CSS custom properties) as opaque colours: each is laid over the surfaces a diagram sits
 * on, since the window's surfaces are translucent and Mermaid works colours out of the ones it's given.
 * A canvas does the laying over, and turns any colour the browser reads (OKLCH, `color-mix`) into RGB.
 */
const flatten = (
  dark: boolean,
  layers: ReadonlyArray<string>,
  tokens: Readonly<Record<string, { readonly token: string; readonly alpha?: number }>>,
): Record<string, string> => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const probe = document.createElement("span");
  document.body.append(probe);
  const paint = (token: string, alpha = 1) => {
    probe.style.color = `var(${token})`;
    context!.globalAlpha = alpha;
    context!.fillStyle = getComputedStyle(probe).color;
    context!.fillRect(0, 0, 1, 1);
  };
  const backdrop = () => {
    context!.globalAlpha = 1;
    context!.fillStyle = dark ? "#000" : "#fff";
    context!.fillRect(0, 0, 1, 1);
    for (const layer of layers) paint(layer);
  };
  const read = () => {
    const [r, g, b] = context!.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((channel) => channel!.toString(16).padStart(2, "0")).join("")}`;
  };
  const colours: Record<string, string> = {};
  if (context !== null) {
    backdrop();
    colours["backdrop"] = read();
    for (const [name, { token, alpha }] of Object.entries(tokens)) {
      backdrop();
      paint(token, alpha);
      colours[name] = read();
    }
  }
  probe.remove();
  return colours;
};

const readTheme = (): DiagramTheme => {
  const dark = document.documentElement.dataset["theme"] !== "light";
  const c = flatten(dark, ["--surface-window", "--surface-panel", "--surface-pane", "--surface-sunken"], {
    text: { token: "--fg-primary" },
    muted: { token: "--fg-secondary" },
    line: { token: "--fg-tertiary" },
    node: { token: "--surface-raised" },
    nodeStrong: { token: "--surface-active" },
    cluster: { token: "--surface-film" },
    border: { token: "--line-strong" },
    running: { token: "--status-running" },
    success: { token: "--status-success" },
    attention: { token: "--status-attention" },
    error: { token: "--status-error" },
    merged: { token: "--status-merged" },
    note: { token: "--status-attention", alpha: 0.16 },
  });
  const backdrop = c["backdrop"]!;
  return {
    font: getComputedStyle(document.body).fontFamily,
    variables: {
      darkMode: String(dark),
      background: backdrop,
      primaryColor: c["node"]!,
      primaryTextColor: c["text"]!,
      primaryBorderColor: c["line"]!,
      secondaryColor: c["nodeStrong"]!,
      secondaryTextColor: c["text"]!,
      secondaryBorderColor: c["line"]!,
      tertiaryColor: c["cluster"]!,
      tertiaryTextColor: c["text"]!,
      tertiaryBorderColor: c["border"]!,
      lineColor: c["line"]!,
      textColor: c["text"]!,
      mainBkg: c["node"]!,
      nodeBorder: c["line"]!,
      nodeTextColor: c["text"]!,
      clusterBkg: c["cluster"]!,
      clusterBorder: c["border"]!,
      titleColor: c["text"]!,
      edgeLabelBackground: backdrop,
      noteBkgColor: c["note"]!,
      noteTextColor: c["text"]!,
      noteBorderColor: c["attention"]!,
      actorBkg: c["node"]!,
      actorBorder: c["line"]!,
      actorTextColor: c["text"]!,
      actorLineColor: c["line"]!,
      signalColor: c["muted"]!,
      signalTextColor: c["text"]!,
      labelBoxBkgColor: c["node"]!,
      labelBoxBorderColor: c["line"]!,
      labelTextColor: c["text"]!,
      loopTextColor: c["muted"]!,
      activationBkgColor: c["nodeStrong"]!,
      activationBorderColor: c["line"]!,
      sequenceNumberColor: backdrop,
      errorBkgColor: c["error"]!,
      errorTextColor: c["text"]!,
      pie1: c["running"]!,
      pie2: c["success"]!,
      pie3: c["attention"]!,
      pie4: c["error"]!,
      pie5: c["merged"]!,
      pieTitleTextColor: c["text"]!,
      pieLegendTextColor: c["text"]!,
      pieStrokeColor: backdrop,
      pieOuterStrokeColor: c["border"]!,
      pieSectionTextColor: backdrop,
    },
  };
};

/** The theme last read, by the mode, palette and desktop colours it was read under. */
let theme: { readonly under: string; readonly read: DiagramTheme } | undefined;
const themeNow = (): string => {
  const { dataset } = document.documentElement;
  const under = `${dataset["theme"]}:${dataset["palette"]}:${dataset["desktop"]}`;
  if (theme?.under !== under) theme = { under, read: readTheme() };
  return theme.under;
};
const currentTheme = (): DiagramTheme => {
  themeNow();
  return theme!.read;
};

/** What a diagram came to: its drawing, or that it doesn't parse. */
type Drawn = { readonly svg: string } | { readonly failed: true };

// Drawings are kept by the theme and source they were drawn for, and read through a store: the compiler
// memoizes a plain read of this map by its key, which would never see a drawing finish.
const drawn = new Map<string, Drawn>();
const KEPT = 80;
const watchers = new Set<() => void>();
const watchDrawings = (onChange: () => void) => {
  watchers.add(onChange);
  return () => void watchers.delete(onChange);
};
const keep = (key: string, next: Drawn) => {
  drawn.set(key, next);
  if (drawn.size > KEPT) drawn.delete(drawn.keys().next().value!);
  for (const onChange of watchers) onChange();
};

/** Drawings under way, so two blocks with the same source draw once. */
const drawing = new Set<string>();

let counter = 0;
const draw = async (source: string): Promise<Drawn> => {
  const id = `mermaid-${counter++}`;
  try {
    const mermaid = await loadMermaid();
    const { variables, font } = currentTheme();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: variables,
      fontFamily: font,
      suppressErrorRendering: true,
    });
    const { svg } = await mermaid.render(id, source);
    return { svg };
  } catch (error) {
    console.error("mermaid", error);
    // A failed render can leave its scratch element in the page.
    document.getElementById(`d${id}`)?.remove();
    return { failed: true };
  }
};

const PLACEHOLDER_HEIGHT = 150;

/**
 * The diagram `source` describes, in a frame like a code block's; `unfinished` while its fence is
 * still open. `fallback` shows the source itself when it doesn't parse.
 */
export function Diagram({
  source,
  unfinished,
  fallback,
}: {
  source: string;
  unfinished: boolean;
  fallback: ReactNode;
}) {
  const under = useSyncExternalStore(subscribeTheme, themeNow);
  const key = `${under}\n${source}`;
  // What was last on screen, so a new theme replaces the drawing in place instead of blanking it.
  const [shown, setShown] = useState<string>();
  const result = useSyncExternalStore(watchDrawings, () => drawn.get(key));

  useEffect(() => {
    if (unfinished || drawn.has(key) || drawing.has(key)) return;
    drawing.add(key);
    void draw(source).then((next) => {
      drawing.delete(key);
      keep(key, next);
    });
  }, [key, source, unfinished]);

  if (result !== undefined && "svg" in result && result.svg !== shown) setShown(result.svg);
  if (result !== undefined && "failed" in result) return fallback;
  const svg = result !== undefined && "svg" in result ? result.svg : shown;
  return (
    <div data-md="code-block" className="group/code relative">
      <div className="flex h-8 items-center gap-1.5 pr-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">Diagram</span>
        <CopyButton
          text={source}
          label="Copy diagram source"
          className="opacity-0 group-focus-within/code:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100"
        />
      </div>
      {svg === undefined ? (
        <div style={{ height: PLACEHOLDER_HEIGHT }} className="grid place-items-center pb-3 text-meta">
          <span className="text-shimmer">Drawing…</span>
        </div>
      ) : (
        <div
          data-md="diagram"
          className="scroll-thin overflow-x-auto px-3.5 pb-3.5 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
