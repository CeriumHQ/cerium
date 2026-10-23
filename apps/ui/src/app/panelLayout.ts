/**
 * The sidebar's width, including the gutter between it and the transcript. On a Mac the traffic
 * lights take the titlebar's corner above it, so it keeps room for the controls beside them.
 */
export const SIDEBAR = {
  key: "cerium:sidebarWidth",
  fallback: 278,
  min: 232,
  macMin: 256,
  max: 420,
} as const;
export const INSPECTOR = { key: "cerium:inspectorWidth", fallback: 320, min: 280, max: 560 } as const;
/** The files panel takes the inspector's place, a little wider for names and their status. */
export const FILES = { key: "cerium:filesWidth", fallback: 340, min: 280, max: 560 } as const;
/** The artifacts panel takes it too, wider for the pages it shows. */
export const ARTIFACTS = { key: "cerium:artifactsWidth", fallback: 360, min: 280, max: 640 } as const;
/** Source control takes it too, as wide as the files panel for paths and their status. */
export const SOURCE_CONTROL = {
  key: "cerium:sourceControlWidth",
  fallback: 340,
  min: 280,
  max: 560,
} as const;
/** GitHub takes it too, a little wider for pull request and issue titles. */
export const GITHUB = { key: "cerium:githubWidth", fallback: 360, min: 280, max: 600 } as const;

/** What a panel beside the transcript is allowed in width. */
export interface SidePanelSpec {
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
}

/** The panels that take the place beside the transcript, one at a time. */
export type SidePanelId = "agents" | "files" | "artifacts" | "git" | "github";

/** Each side panel's width, saved under `key`, and what its resize handle is called. */
export const SIDE_PANELS: Readonly<
  Record<SidePanelId, SidePanelSpec & { readonly key: string; readonly resizeLabel: string }>
> = {
  agents: { ...INSPECTOR, resizeLabel: "Resize agents panel" },
  files: { ...FILES, resizeLabel: "Resize files panel" },
  artifacts: { ...ARTIFACTS, resizeLabel: "Resize artifacts panel" },
  git: { ...SOURCE_CONTROL, resizeLabel: "Resize source control panel" },
  github: { ...GITHUB, resizeLabel: "Resize GitHub panel" },
};
/** The gap between panels, and around the window's edge. */
export const GUTTER = 6;
/** Below this the transcript is too narrow for its message box, so the inspector floats over it instead. */
export const MIN_TRANSCRIPT = 480;

export const clampWidth = (width: number, min: number, max: number) =>
  Math.min(Math.max(width, min), Math.max(min, max));

export interface PanelLayout {
  readonly sidebarWidth: number;
  readonly sidebarMax: number;
  /** What the sidebar takes of the row: its width while it shows, else just its gutter. */
  readonly sidebarSpace: number;
  /** The inspector floats over the transcript rather than sitting beside it. */
  readonly floating: boolean;
  readonly inspectorWidth: number;
  readonly inspectorMax: number;
}

/**
 * How the window divides `bodyWidth` between its panels, given the widths the user last left them at.
 * The sidebar never takes more than 40% of the window. The inspector sits beside the transcript while
 * that keeps its room, and floats over it once it wouldn't.
 */
export const panelLayout = (
  bodyWidth: number,
  saved: { readonly sidebar: number; readonly inspector: number },
  sidebarShown: boolean,
  /** The panel beside the transcript: the inspector, or the files panel (which keeps its own saved width in `inspector`). */
  side: SidePanelSpec = INSPECTOR,
  sidebarMin: number = SIDEBAR.min,
): PanelLayout => {
  const sidebarMax = Math.min(SIDEBAR.max, Math.floor(bodyWidth * 0.4));
  const sidebarWidth = clampWidth(saved.sidebar, sidebarMin, sidebarMax);
  const sidebarSpace = sidebarShown ? sidebarWidth : GUTTER;
  const roomBeside = bodyWidth - sidebarSpace - GUTTER * 2 - MIN_TRANSCRIPT;
  const floating = roomBeside < side.min;
  const inspectorMax = Math.min(side.max, floating ? bodyWidth - sidebarSpace - GUTTER * 8 : roomBeside);
  return {
    sidebarWidth,
    sidebarMax,
    sidebarSpace,
    floating,
    inspectorWidth: clampWidth(saved.inspector, side.min, inspectorMax),
    inspectorMax,
  };
};
