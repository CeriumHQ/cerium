import { type ThreadOverview } from "@cerium/rpc";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import { useContext, useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { sendMessage } from "../backend/atoms.ts";
import { machineAtom } from "../backend/machine.ts";
import { leadOf } from "../backend/view.ts";
import {
  previewBridge,
  previewStates,
  setLocalOpener,
  subscribePreviews,
} from "../features/preview/model.ts";
import { PreviewPane } from "../features/preview/PreviewPane.tsx";
import { usePreviewDocks } from "../features/preview/usePreviewDocks.ts";

import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";

type ResolvedThread = ReturnType<WorkspaceThreads["resolve"]>;

export function useWorkspacePreview({
  driven,
  solo,
  selected,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly selected: ThreadOverview | undefined;
}) {
  const registry = useContext(RegistryContext);
  const send = useAtomSet(sendMessage, { mode: "promise" });
  /**
   * The open thread's browser, docked in its pane beside the conversation: the desktop app's own
   * threads each have one, which the user browses and the thread's agents drive (features/preview).
   */
  const previews = useSyncExternalStore(subscribePreviews, previewStates);
  const previewDocks = usePreviewDocks();
  // The shell lays the pages over the main window alone.
  const previewsHere = previewBridge() !== undefined && driven === undefined && !solo;
  const previewThread = previewsHere && selected !== undefined ? selected.thread.id : undefined;
  const previewOpen = previewThread !== undefined && previewDocks.isOpen(previewThread);
  const togglePreview = () => {
    if (previewThread === undefined) return;
    if (previewOpen) previewDocks.hide(previewThread);
    else previewDocks.show(previewThread);
  };
  // A local address a terminal links or prints opens in the open thread's preview.
  const openLink = useEffectEvent((url: string) => {
    if (previewThread === undefined) return;
    void previewBridge()?.navigate(previewThread, url);
    previewDocks.show(previewThread);
  });
  const linksOpen = previewThread !== undefined;
  useEffect(() => {
    if (!linksOpen) return;
    setLocalOpener(openLink);
    return () => setLocalOpener(undefined);
  }, [linksOpen]);

  const paneFor = (resolved: ResolvedThread) => {
    // Each of this computer's threads keeps its own browser, beside it in whichever pane shows it.
    const previewed = previewsHere ? resolved.listed?.thread.id : undefined;
    if (previewed === undefined || !previewDocks.isOpen(previewed)) return undefined;
    return (
      <PreviewPane
        key={previewed}
        threadId={previewed}
        onSendIssues={async () => {
          const bridge = previewBridge();
          const agent = resolved.shown && leadOf(resolved.shown.agents);
          if (!bridge || !agent) throw new Error("The thread's agent is unavailable.");
          const { url, issues } = await bridge.issues(previewed);
          const last = issues.at(-1);
          if (!last) return;
          if (registry.get(machineAtom) !== undefined) throw new Error("The preview's machine has changed.");
          const text = [`Preview issues from ${url}`, ...issues.map((issue) => issue.text)].join("\n\n");
          await send({ payload: { agentId: agent.id, text } });
          await bridge.acknowledge(previewed, last.id);
        }}
        onClose={() => previewDocks.close(previewed)}
      />
    );
  };

  return { paneFor, previewDocks, previewThread, previewOpen, togglePreview, previews };
}

export type WorkspacePreview = ReturnType<typeof useWorkspacePreview>;
