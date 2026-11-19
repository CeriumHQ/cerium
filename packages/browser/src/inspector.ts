/** The renderer and shell share only the inspector's data across the preload bridge. */
export const viewportWidths = { fit: undefined, desktop: 1280, tablet: 768, phone: 390 } as const;
export type PreviewViewport = keyof typeof viewportWidths;
export type PreviewTheme = "system" | "light" | "dark";

export interface PreviewElement {
  readonly tag: string;
  readonly selector: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
  readonly html: string;
  readonly styles: Readonly<Record<string, string>>;
  readonly component?: string;
  readonly source?: string;
}

export interface PreviewInspectorState {
  readonly picking: boolean;
  readonly hover?: string;
  readonly inspectorError?: string;
  readonly viewport: PreviewViewport;
  readonly theme: PreviewTheme;
  readonly issueCount: number;
}

export interface PreviewIssue {
  readonly id: number;
  readonly text: string;
}
