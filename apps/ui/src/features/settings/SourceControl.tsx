import type { ProjectInfo } from "@cerium/protocol";
import type { ProjectScripts } from "@cerium/rpc";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { FolderGit2, GitBranchPlus } from "lucide-react";
import { useState } from "react";

import { savedProjectsAtom } from "../../backend/projects.ts";
import { projectScriptsAtom, setProjectScripts } from "../../backend/scripts.ts";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { GitHubRow } from "../github/GitHubSettings.tsx";
import { RowButton } from "./ToolRow.tsx";
import { SettingsList, SettingsPage, SettingsRow, SettingsSection } from "./parts.tsx";
import { workplaceAtom } from "./preferences.ts";

const workplaces = {
  local: { label: "Local", description: "In the project's folder, on its branch" },
  worktree: { label: "Worktree", description: "A branch of its own, in a worktree" },
} as const;

const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-line-strong bg-transparent px-2.5 text-body text-fg-primary outline-none placeholder:text-fg-tertiary focus-visible:border-fg-tertiary";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** What a command came from, as its field says: the user's, the project's own, or a guess to confirm. */
const SOURCE = { saved: "Saved", project: ".cerium.toml", guessed: "Cerium's guess" } as const;

/**
 * Git and GitHub: where a new work thread in a git project runs, and the machine's GitHub CLI, which
 * pull requests and issues go through. A project's scripts are here too: the setup command its new
 * worktrees run, and the run command a thread's Run button starts.
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
      <ProjectScriptsSection />
    </SettingsPage>
  );
}

/**
 * The projects on this machine, and the setup and run commands the user chose for the one that shows.
 * A project's `.cerium.toml` or a guessed command is filled in for the user to keep or change; what's
 * saved wins.
 */
function ProjectScriptsSection() {
  const listed = useAtomValue(savedProjectsAtom);
  const refreshProjects = useAtomRefresh(savedProjectsAtom);
  const projects = AsyncResult.getOrElse(listed, (): ReadonlyArray<ProjectInfo> => []).filter(
    (project) => project.missing !== true,
  );
  const shown = projects[0]?.path;
  return (
    <SettingsSection
      title="Project scripts"
      description="What a work thread in a project runs: setup installs what it needs when a worktree is made, run keeps the project going. What isn't saved here comes from the project's .cerium.toml, else a guess Cerium makes in its place."
    >
      {projects.length === 0 ? (
        <p className="rounded-xl border border-line-subtle px-4 py-3 text-body text-fg-tertiary">
          No projects yet: open a folder in a new work thread, and its commands are set here.
        </p>
      ) : (
        <ProjectScriptFields key={shown} project={shown!} onSaved={refreshProjects} />
      )}
    </SettingsSection>
  );
}

/** The one project's two script fields: what each command is now, and what the user wants it to be. */
function ProjectScriptFields({
  project,
  onSaved,
}: {
  project: string;
  /** The saved projects, which a first save adds the folder to. */
  onSaved: () => void;
}) {
  const resolved = useAtomValue(projectScriptsAtom(project));
  const refreshResolved = useAtomRefresh(projectScriptsAtom(project));
  const [setup, setSetup] = useState<string>();
  const [run, setRun] = useState<string>();
  const [filled, setFilled] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = useAtomSet(setProjectScripts, { mode: "promise" });
  const value = AsyncResult.getOrElse(resolved, (): ProjectScripts => ({}));

  // The fields start at what the resolution offers: the saved word, the project's own, or the guess.
  // Set while rendering, as React suggests for state that follows a prop, rather than in an effect.
  if (!filled && AsyncResult.isSuccess(resolved)) {
    setSetup(value.setup?.text ?? "");
    setRun(value.run?.text ?? "");
    setFilled(true);
  }
  const identity = (kind: "setup" | "run", text: string | undefined) => {
    const one = value[kind];
    // Unchanged and already the user's: saved again the same. Unchanged from the file or a guess:
    // left as it was, so the project's own word can change underneath it later.
    if (text === undefined) return null;
    if (one === undefined) return text === "" ? "" : text;
    return text === one.text && one.from !== "saved" ? null : text;
  };

  const saveChanges = () => {
    if (busy || setup === undefined || run === undefined) return;
    setError(undefined);
    setBusy(true);
    save({
      // An empty field turns a command off; null leaves whatever the project itself offers standing.
      payload: { path: project, setup: identity("setup", setup), run: identity("run", run) },
    }).then(
      () => {
        setBusy(false);
        setFresh(true);
        refreshResolved();
        onSaved();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };

  if (AsyncResult.isFailure(resolved)) {
    return (
      <p className="rounded-xl border border-line-subtle px-4 py-3 text-body text-fg-tertiary">
        Cerium's backend on this machine couldn't read the project: {messageOf(Cause.squash(resolved.cause))}.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line-subtle px-4 py-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        {(["setup", "run"] as const).map((kind) => {
          const text = kind === "setup" ? setup : run;
          const setText = kind === "setup" ? setSetup : setRun;
          const from = value[kind]?.from;
          return (
            <label key={kind} className="flex min-w-0 flex-col gap-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-meta font-medium text-fg-secondary">
                  {kind === "setup" ? "Setup" : "Run"}
                </span>
                {filled && from !== undefined ? (
                  <span className="text-caption text-fg-tertiary">{SOURCE[from]}</span>
                ) : null}
              </span>
              <input
                value={text ?? ""}
                onChange={(event) => {
                  setText(event.target.value);
                  setFresh(false);
                }}
                spellCheck={false}
                autoComplete="off"
                aria-label={`${kind === "setup" ? "Setup" : "Run"} command for ${project}`}
                className={fieldClass}
              />
            </label>
          );
        })}
      </div>
      <div className="flex min-h-6 items-center gap-3">
        <RowButton tone="primary" onClick={saveChanges}>
          {busy ? "Saving…" : "Save"}
        </RowButton>
        <div className="flex min-w-0 flex-1 items-center">
          {error !== undefined ? (
            <span className="truncate text-meta text-error-text">{error}</span>
          ) : fresh ? (
            <span className="text-meta text-fg-tertiary">Saved.</span>
          ) : null}
        </div>
        <span className="max-w-40 shrink-0 truncate text-caption text-fg-tertiary" title={project}>
          {nameOf(project)}
        </span>
      </div>
    </div>
  );
}

/** A folder path as the user knows a project: its own name. */
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
