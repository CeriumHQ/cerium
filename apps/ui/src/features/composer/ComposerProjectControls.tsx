import { type RefObject } from "react";

import { type Draft } from "./draft.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { WorktreePicker } from "./WorktreePicker.tsx";

import type { ComposerTarget } from "./composerTypes.ts";
import type { StartChoices } from "./useStartChoices.ts";

export function ComposerProjectControls({
  target,
  start,
  draft,
  projectsOpen,
  setProjectsOpen,
  asksForProject,
  input,
  unfolded,
}: {
  readonly target: Extract<ComposerTarget, { kind: "new" }>;
  readonly start: StartChoices;
  readonly draft: Draft;
  readonly projectsOpen: boolean;
  readonly setProjectsOpen: (open: boolean) => void;
  readonly asksForProject: boolean;
  readonly input: RefObject<HTMLDivElement | null>;
  readonly unfolded: boolean;
}) {
  const { gitFolder, branch, worktree, pickForDraft, setWorkplace } = start;
  return (
    <div className={`flex min-w-0 items-center ${unfolded ? "write-in [--write-delay:90ms]" : ""}`}>
      <ProjectPicker
        folder={target.folder}
        open={projectsOpen}
        onOpenChange={setProjectsOpen}
        needed={asksForProject}
        returnFocus={input}
        onChoose={(folder) => {
          target.onChooseFolder(folder);
          pickForDraft({ folder });
        }}
      />
      {gitFolder !== undefined && branch !== undefined ? (
        <>
          <span aria-hidden className="text-meta text-fg-disabled">
            /
          </span>
          {target.workspaceControls ? (
            <WorkspacePicker
              key={gitFolder}
              root={gitFolder}
              branch={branch}
              value={worktree}
              workspace={draft.start?.workspace}
              onPick={(picked, workspace) => {
                setWorkplace(picked ? "worktree" : "local");
                pickForDraft({ worktree: picked, workspace });
              }}
            />
          ) : (
            <WorktreePicker
              branch={branch}
              value={worktree}
              onPick={(picked) => {
                setWorkplace(picked ? "worktree" : "local");
                pickForDraft({ worktree: picked, workspace: undefined });
              }}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
