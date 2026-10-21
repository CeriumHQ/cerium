import type { FileChange } from "@cerium/rpc";
import { useState } from "react";

import { CommitView } from "./CommitView.tsx";
import { HistoryList } from "./HistoryList.tsx";

// The History tab: the branch's commits, and one of them open in full. The list stays mounted while a
// commit is open, so its search and the pages it has read are still there when the user comes back.

interface HistoryPanelProps {
  /** The repository's folder whose commits are listed. */
  readonly root: string;
  /** Opens a file as one commit changed it, against the commit's first parent, in the viewer. */
  readonly onOpenFile: (sha: string, file: FileChange) => void;
}

export function HistoryPanel({ root, onOpenFile }: HistoryPanelProps) {
  const [sha, setSha] = useState<string>();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={sha === undefined ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <HistoryList root={root} onOpen={setSha} />
      </div>
      {sha === undefined ? null : (
        <CommitView
          key={sha}
          root={root}
          sha={sha}
          onBack={() => setSha(undefined)}
          onOpenFile={(file) => onOpenFile(sha, file)}
        />
      )}
    </div>
  );
}
