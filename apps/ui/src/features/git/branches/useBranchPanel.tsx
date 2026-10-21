import { useState, type ReactNode } from "react";

import { BranchDialogs, type BranchDialog } from "./BranchDialogs.tsx";
import { BranchMenu } from "./BranchMenu.tsx";
import { BranchNotice } from "./BranchNotice.tsx";
import { OperationBanner } from "./OperationBanner.tsx";
import { StashMenu } from "./StashMenu.tsx";
import { SyncButton } from "./SyncButton.tsx";
import { useBranchControls } from "./useBranchControls.ts";
import { useQuietFetch } from "./useQuietFetch.ts";

/** The pieces of Source control that belong to the branch: where each goes is the panel's to say. */
export interface BranchPanel {
  /** The branch, how it stands with the remote, and the stash: the panel's header. */
  readonly header: ReactNode;
  /** What the last change told the user. */
  readonly notice: ReactNode;
  /** What git stopped halfway through and the files to settle; above the changes. */
  readonly banner: ReactNode;
  /** The questions the controls ask first; rendered anywhere, they float over the panel. */
  readonly dialogs: ReactNode;
}

/**
 * Source control's branch, sync, stash and merge controls for the repository the folder `root` is in,
 * kept current while the panel is open. `onOpen` shows a conflicted file, by its path from the top.
 */
export function useBranchPanel({
  root,
  onOpen,
}: {
  readonly root: string;
  readonly onOpen: ((path: string) => void) | undefined;
}): BranchPanel {
  const controls = useBranchControls(root);
  const [dialog, setDialog] = useState<BranchDialog | undefined>(undefined);
  useQuietFetch(root, (controls.state?.remotes.length ?? 0) > 0);
  return {
    header: (
      // A container, so the sync button gives up its label before the branch gives up its name.
      <div className="@container flex min-w-0 flex-1 items-center gap-1">
        <BranchMenu root={root} controls={controls} onAsk={setDialog} />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <SyncButton root={root} controls={controls} onAsk={setDialog} />
          <StashMenu root={root} controls={controls} onAsk={setDialog} />
        </div>
      </div>
    ),
    notice: <BranchNotice controls={controls} />,
    banner: <OperationBanner controls={controls} onAsk={setDialog} onOpen={onOpen} />,
    dialogs: (
      <BranchDialogs root={root} controls={controls} dialog={dialog} onClose={() => setDialog(undefined)} />
    ),
  };
}
