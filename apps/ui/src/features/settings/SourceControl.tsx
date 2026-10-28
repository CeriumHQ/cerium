import type { ProjectInfo } from "@cerium/protocol";
import type { ProjectScripts } from "@cerium/rpc";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { savedProjectsAtom } from "../../backend/projects.ts";
import { projectScriptsAtom, setProjectScripts } from "../../backend/scripts.ts";
import { GitHubRow } from "../github/GitHubSettings.tsx";
import { RowButton } from "./ToolRow.tsx";
import { SettingsCard, SettingsList, SettingsNote, SettingsPage, SettingsSection } from "./parts.tsx";

const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-line-strong bg-transparent px-2.5 text-body text-fg-primary outline-none placeholder:text-fg-tertiary focus-visible:border-fg-tertiary";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** What a command came from, as its field says: the user's, the project's own, or a guess to confirm. */
const SOURCE = { saved: "Saved", project: ".cerium.toml", guessed: "Cerium's guess" } as const;

/**
 * Git and GitHub: the machine's GitHub CLI, which pull requests and issues go through, and a
 * project's scripts: the setup command its new worktrees run, and the run command a thread's Run
 * button starts. Where a new work thread runs is with the rest of a new thread's defaults.
 */
export function SourceControlSettings() {
  return (
    <SettingsPage perMachine title="Git & GitHub">
      <SettingsSection
        title="GitHub"
        description="Pull requests and issues go through GitHub's own CLI, which keeps its sign-in."
      >
        <SettingsList>
          <GitHubRow />
        </SettingsList>
      </SettingsSection>
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
      description="Setup runs when a worktree is made; Run keeps the project going. Unsaved, each comes from the project's .cerium.toml, or Cerium's guess."
    >
      {projects.length === 0 ? (
        <SettingsNote>
          No projects yet. Open a folder in a new work thread to set its commands here.
        </SettingsNote>
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
      <SettingsNote>
        Cerium's backend on this machine couldn't read the project: {messageOf(Cause.squash(resolved.cause))}.
      </SettingsNote>
    );
  }
  return (
    <SettingsCard className="flex flex-col gap-3 px-4 py-3">
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
    </SettingsCard>
  );
}

/** A folder path as the user knows a project: its own name. */
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
