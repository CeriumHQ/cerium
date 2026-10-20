// Artifacts: HTML pages an agent writes into its reply when a visual explains better than prose. The UI
// renders each in a sandboxed frame with the app's theme; the bus's preview tool renders the same
// document headless so the agent can look at it first; agents learn both from `artifactGuide`.

export {
  ARTIFACT_POLICY,
  artifactDocument,
  artifactHostPage,
  fontFaces,
  isLegacyArtifact,
  themeUpdate,
} from "./document.ts";
export { ARTIFACT_LANGUAGE, artifactBlocks, artifactId, artifactTitle, newestArtifacts } from "./extract.ts";
export { artifactGuide } from "./guide.ts";
export { ARTIFACT_COLUMN_WIDTH, ARTIFACT_MAX_HEIGHT } from "./limits.ts";
export {
  dataFileUrl,
  localFiles,
  localFileType,
  MAX_DATA_BYTES,
  withLocalFiles,
  type LocalFileKind,
} from "./local.ts";
export { readFrameMessage, RENDER_MESSAGE, THEME_MESSAGE, type FrameMessage } from "./runtime.ts";
export {
  BACKDROPS,
  DEFAULT_THEMES,
  THEME_TOKENS,
  themeFromTokens,
  type ArtifactMode,
  type ArtifactTheme,
} from "./theme.ts";
