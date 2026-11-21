import { useState } from "react";

import type { SidePanelId } from "./panelLayout.ts";

export function useWorkspacePanels() {
  /**
   * The panel beside the conversation: the agents (the inspector), the files, the artifacts, Source
   * control or GitHub, which take that place one at a time.
   */
  const [sidePanel, setSidePanel] = useState<SidePanelId>();
  const inspectorOpen = sidePanel === "agents";
  const filesOpen = sidePanel === "files";
  const artifactsOpen = sidePanel === "artifacts";
  const gitOpen = sidePanel === "git";
  const githubOpen = sidePanel === "github";
  /** Opens `panel` in that place, or closes it when it's the one open. */
  const togglePanel = (panel: SidePanelId) => setSidePanel((open) => (open === panel ? undefined : panel));
  /** Closes `panel`, when it's the one open. */
  const closePanel = (panel: SidePanelId) => setSidePanel((open) => (open === panel ? undefined : open));
  /** The agent the inspector shows; the lead until another is picked. */
  const [inspectedAgent, setInspectedAgent] = useState<string>();
  const toggleInspector = () => togglePanel("agents");
  const toggleFiles = () => togglePanel("files");
  const toggleGit = () => togglePanel("git");
  const toggleGitHub = () => togglePanel("github");
  const toggleArtifacts = () => togglePanel("artifacts");

  return {
    inspectorOpen,
    filesOpen,
    artifactsOpen,
    gitOpen,
    githubOpen,
    togglePanel,
    closePanel,
    setSidePanel,
    inspectedAgent,
    setInspectedAgent,
    toggleInspector,
    toggleFiles,
    toggleGit,
    toggleGitHub,
    toggleArtifacts,
  };
}

export type WorkspacePanels = ReturnType<typeof useWorkspacePanels>;
