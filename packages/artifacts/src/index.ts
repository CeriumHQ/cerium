// Artifacts: HTML an agent writes into its reply when a visual explains better than prose. The UI
// renders them with `artifact.css`; agents learn its building blocks from `artifactGuide`. Both ship
// from this package so the guide and the stylesheet change together.

export { artifactGuide } from "./guide.ts";

/** The code fence language that marks an artifact in agent markdown. */
export const ARTIFACT_LANGUAGE = "artifact";
