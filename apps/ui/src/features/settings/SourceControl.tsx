import { useAtom } from "@effect/atom-react";
import { FolderGit2, GitBranchPlus } from "lucide-react";

import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { GitHubRow } from "../github/GitHubSettings.tsx";
import { SettingsList, SettingsPage, SettingsRow } from "./parts.tsx";
import { workplaceAtom } from "./preferences.ts";

const workplaces = {
  local: { label: "Local", description: "In the project's folder, on its branch" },
  worktree: { label: "Worktree", description: "A branch of its own, in a worktree" },
} as const;

/**
 * Git and GitHub: where a new work thread in a git project runs, and the machine's GitHub CLI, which
 * pull requests and issues go through.
 */
export function SourceControlSettings() {
  const [workplace, setWorkplace] = useAtom(workplaceAtom);
  return (
    <SettingsPage
      perMachine
      title="Source control"
      description="Pull requests and issues go through GitHub's own CLI, which keeps its sign-in."
    >
      <SettingsList>
        <SettingsRow
          label="New work threads run"
          hint={`${workplaces[workplace].description}. The message box changes it for one thread.`}
          className="pr-2.5"
          control={() => (
            <SelectRoot value={workplace} onValueChange={(next) => next !== null && setWorkplace(next)}>
              <SelectTrigger label="Where new work threads run">
                <span className="font-medium text-fg-primary">{workplaces[workplace].label}</span>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="local" icon={FolderGit2} description={workplaces.local.description}>
                  {workplaces.local.label}
                </SelectItem>
                <SelectItem
                  value="worktree"
                  icon={GitBranchPlus}
                  description={workplaces.worktree.description}
                >
                  {workplaces.worktree.label}
                </SelectItem>
              </SelectPopup>
            </SelectRoot>
          )}
        />
        <GitHubRow />
      </SettingsList>
    </SettingsPage>
  );
}
