import { Button } from "@base-ui/react/button";
import { Select as BaseSelect } from "@base-ui/react/select";
import type { ProjectInfo } from "@cerium/protocol";
import { ACTION_NAME_MAX, type ProjectScripts, type ScriptSource } from "@cerium/rpc";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, Plus, X } from "lucide-react";
import { use, useEffect, useState } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { savedProjectsAtom } from "../../backend/projects.ts";
import { projectScriptsAtom, setProjectScripts, writeProjectScriptsFile } from "../../backend/scripts.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { SelectItem, SelectPopup, SelectRoot } from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { projectName, projectPlace } from "../composer/projectList.ts";
import { GitHubRow } from "../github/GitHubSettings.tsx";
import { ProjectBadge } from "../threads/ProjectBadge.tsx";
import {
  SettingsCard,
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsProject,
  SettingsSection,
} from "./parts.tsx";
import {
  SCRIPT_FIELDS,
  SOURCE_TEXT,
  actionsSaved,
  alreadyInFile,
  changed,
  commandsOf,
  initialProject,
  rowProblems,
  rowsOf,
  savedActions,
  savedWord,
  textsOf,
  type ActionRow,
  type ScriptField,
} from "./scriptsModel.ts";
import { RowButton } from "./ToolRow.tsx";
import { useActionsOffered } from "./useActionsOffered.ts";

const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 text-body text-fg-primary outline-none placeholder:text-fg-tertiary focus-visible:border-fg-tertiary";

/** A name or command field's border: quiet, or red while the row it's in has something wrong. */
const borderClass = (invalid: boolean) => (invalid ? "border-error-text" : "border-line-strong");

/** A row of the card: what it's for, its field, and what sits at the end (where it came from, a remove button). */
const rowClass =
  "grid grid-cols-[6rem_minmax(0,1fr)_5.5rem] items-center gap-x-2.5 max-sm:grid-cols-[4.5rem_minmax(0,1fr)_1.75rem]";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/**
 * Git and GitHub: the machine's GitHub CLI, which pull requests and issues go through, and a
 * project's scripts: the setup command its new worktrees run, the run command a thread's Run
 * button starts, and its named actions. Where a new work thread runs is with the rest of a new
 * thread's defaults.
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
 * The projects on this machine, and the commands of the one that shows: the one the user came from
 * when Settings was opened on a thread, else the first. A project's `.cerium.toml` or a guessed
 * command is filled in for the user to keep or change; what's saved wins.
 */
function ProjectScriptsSection() {
  const listed = useAtomValue(savedProjectsAtom);
  const refreshProjects = useAtomRefresh(savedProjectsAtom);
  const from = use(SettingsProject);
  const [picked, setPicked] = useState<string>();
  const projects = AsyncResult.getOrElse(listed, (): ReadonlyArray<ProjectInfo> => []).filter(
    (project) => project.missing !== true,
  );
  const paths = projects.map((project) => project.path);
  const shown = picked !== undefined && paths.includes(picked) ? picked : initialProject(paths, from);
  return (
    <SettingsSection
      title={
        <>
          Project scripts
          <InfoTip label="About project scripts" side="bottom">
            Setup runs when a worktree is made, Run starts the project, Teardown clears up as its thread is
            archived or deleted, and actions are more commands in a thread's Run menu. Save keeps them on this
            machine; Save to .cerium.toml shares them with the project's team.
          </InfoTip>
        </>
      }
      action={
        shown === undefined ? null : <ProjectSelect projects={paths} shown={shown} onPick={setPicked} />
      }
    >
      {shown === undefined ? (
        <SettingsNote>
          No projects yet. Open a folder in a new work thread to set its commands here.
        </SettingsNote>
      ) : (
        <ProjectScriptFields key={shown} project={shown} onSaved={refreshProjects} />
      )}
    </SettingsSection>
  );
}

/** Which project the card edits: a menu of the saved ones, or just the name while there is only one. */
export function ProjectSelect({
  projects,
  shown,
  onPick,
}: {
  projects: ReadonlyArray<string>;
  shown: string;
  onPick: (project: string) => void;
}) {
  const lookup = useAtomValue(machineAtom) === undefined;
  const mark = <ProjectBadge folder={shown} name={projectName(shown)} size="small" lookup={lookup} />;
  if (projects.length < 2) {
    return (
      <span className="flex h-7 min-w-0 items-center gap-1.5 text-meta text-fg-secondary" title={shown}>
        {mark}
        <span className="truncate">{projectName(shown)}</span>
      </span>
    );
  }
  return (
    <SelectRoot value={shown} onValueChange={(next: string | null) => next !== null && onPick(next)}>
      <BaseSelect.Trigger
        aria-label="Project"
        className="flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-md border border-line-subtle px-2 text-meta text-fg-secondary transition-colors select-none hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-hover data-popup-open:text-fg-primary"
      >
        {mark}
        <span className="truncate">{projectName(shown)}</span>
        <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-fg-tertiary" />
      </BaseSelect.Trigger>
      <SelectPopup side="bottom">
        {projects.map((project) => (
          <SelectItem key={project} value={project} description={projectPlace(project)}>
            {projectName(project)}
          </SelectItem>
        ))}
      </SelectPopup>
    </SelectRoot>
  );
}

/**
 * Where a command came from, in a word at the end of its row; what that means shows on hover, and a
 * screen reader reads it with the field (`id` is what the field is described by).
 */
function SourceTag({ id, from }: { id: string; from: ScriptSource | undefined }) {
  if (from === undefined) return <span />;
  const { label, detail } = SOURCE_TEXT[from];
  return (
    <Tooltip label={detail} side="top">
      <span
        id={id}
        aria-label={`${label}. ${detail}`}
        className="cursor-default truncate text-right text-caption text-fg-tertiary hover:text-fg-secondary max-sm:hidden"
      >
        {label}
      </span>
    </Tooltip>
  );
}

/** The one project's commands: what each is now, and what the user wants it to be. */
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
  const actionsOk = useActionsOffered();
  const [texts, setTexts] = useState<Record<ScriptField, string>>();
  const [rows, setRows] = useState<ReadonlyArray<ActionRow>>([]);
  const [nextId, setNextId] = useState(0);
  /** The row just added, whose name field takes the focus. */
  const [added, setAdded] = useState<number>();
  const [note, setNote] = useState<{ readonly tone: "done" | "error"; readonly text: string }>();
  const [busy, setBusy] = useState<"machine" | "file">();
  const save = useAtomSet(setProjectScripts, { mode: "promise" });
  const write = useAtomSet(writeProjectScriptsFile, { mode: "promise" });
  const value = AsyncResult.getOrElse(resolved, (): ProjectScripts => ({}));

  // The fields start at what the resolution offers: the saved word, the project's own, or the guess.
  // Set while rendering, as React suggests for state that follows a prop, rather than in an effect.
  if (texts === undefined && AsyncResult.isSuccess(resolved)) {
    setTexts(textsOf(value));
    setRows(rowsOf(value));
    setNextId(value.actions?.length ?? 0);
  }
  const state = { texts: texts ?? textsOf(value), rows };
  const problems = rowProblems(rows);
  const problem = [...problems.values()][0];
  const dirty = changed(value, state);

  // A row just added takes the focus in its name field, once it's drawn.
  useEffect(() => {
    if (added !== undefined) document.getElementById(`action-name-${added}`)?.focus();
  }, [added]);

  const edit = (change: () => void) => {
    change();
    setNote(undefined);
  };

  const submit = (to: "machine" | "file") => {
    if (busy !== undefined || texts === undefined || problems.size > 0) return;
    setNote(undefined);
    setBusy(to);
    const typed = { setup: texts.setup.trim(), run: texts.run.trim(), teardown: texts.teardown.trim() };
    const request: Promise<unknown> =
      to === "machine"
        ? save({
            payload: {
              path: project,
              setup: savedWord(value, "setup", typed.setup),
              run: savedWord(value, "run", typed.run),
              teardown: savedWord(value, "teardown", typed.teardown),
              ...(actionsOk ? { actions: savedActions(value, rows) } : {}),
            },
          })
        : write({ payload: { path: project, ...typed, actions: commandsOf(rows) } });
    request.then(
      () => {
        setBusy(undefined);
        setNote({
          tone: "done",
          text: to === "machine" ? "Saved on this machine." : "Written to .cerium.toml.",
        });
        refreshResolved();
        onSaved();
      },
      (failure: unknown) => {
        setBusy(undefined);
        setNote({ tone: "error", text: messageOf(failure) });
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

  const listFrom: ScriptSource | undefined =
    value.actions === undefined ? undefined : actionsSaved(value) ? "saved" : "project";
  const submitOnEnter = (event: { readonly key: string }) => {
    if (event.key === "Enter") submit("machine");
  };
  const status = note ?? (problem === undefined ? undefined : { tone: "error" as const, text: problem });

  return (
    <SettingsCard className="flex flex-col divide-y divide-line-subtle">
      <div className="flex flex-col gap-2.5 px-4 py-3">
        {SCRIPT_FIELDS.map(({ kind, label }) => (
          <div key={kind} className={rowClass}>
            <label htmlFor={`script-${kind}`} className="text-meta font-medium text-fg-secondary">
              {label}
            </label>
            <input
              id={`script-${kind}`}
              value={state.texts[kind]}
              onChange={(event) => edit(() => setTexts({ ...state.texts, [kind]: event.target.value }))}
              onKeyDown={submitOnEnter}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${label} command for ${projectName(project)}`}
              aria-describedby={`script-${kind}-from`}
              className={`${fieldClass} ${borderClass(false)}`}
            />
            <SourceTag
              id={`script-${kind}-from`}
              from={texts === undefined ? undefined : value[kind]?.from}
            />
          </div>
        ))}
      </div>

      {actionsOk ? (
        <div className="flex flex-col gap-2.5 px-4 py-3">
          <div className={rowClass}>
            <span className="text-meta font-medium text-fg-secondary">Actions</span>
            <span className="flex min-w-0 items-center">
              <Button
                onClick={() => {
                  edit(() => setRows([...rows, { id: nextId, name: "", command: "" }]));
                  setAdded(nextId);
                  setNextId(nextId + 1);
                }}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
              >
                <Plus size={13} strokeWidth={2} />
                Add
              </Button>
            </span>
            <SourceTag id="script-actions-from" from={listFrom} />
          </div>
          {rows.map((row) => {
            const invalid = problems.has(row.id);
            const update = (change: Partial<ActionRow>) =>
              edit(() => setRows(rows.map((each) => (each.id === row.id ? { ...each, ...change } : each))));
            return (
              <div key={row.id} className={rowClass}>
                <input
                  id={`action-name-${row.id}`}
                  value={row.name}
                  onChange={(event) => update({ name: event.target.value })}
                  onKeyDown={submitOnEnter}
                  placeholder="Name"
                  maxLength={ACTION_NAME_MAX}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Action name"
                  aria-invalid={invalid}
                  className={`${fieldClass} ${borderClass(invalid)}`}
                />
                <input
                  value={row.command}
                  onChange={(event) => update({ command: event.target.value })}
                  onKeyDown={submitOnEnter}
                  placeholder="Command"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={`Command for ${row.name.trim() === "" ? "the new action" : row.name.trim()}`}
                  aria-invalid={invalid}
                  className={`${fieldClass} ${borderClass(invalid)}`}
                />
                <span className="flex justify-end">
                  <IconButton
                    icon={X}
                    label="Remove action"
                    onClick={() => edit(() => setRows(rows.filter((each) => each.id !== row.id)))}
                  />
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2.5">
        <Tooltip label="Keeps these on this machine only" side="top">
          <RowButton
            tone="primary"
            disabled={!dirty || busy !== undefined || problems.size > 0}
            onClick={() => submit("machine")}
          >
            {busy === "machine" ? "Saving…" : "Save"}
          </RowButton>
        </Tooltip>
        {actionsOk ? (
          <Tooltip
            label="Writes them into the project's .cerium.toml, made if it's missing, for its team to share"
            side="top"
          >
            <RowButton
              disabled={alreadyInFile(value, state) || busy !== undefined || problems.size > 0}
              onClick={() => submit("file")}
            >
              {busy === "file" ? "Writing…" : "Save to .cerium.toml"}
            </RowButton>
          </Tooltip>
        ) : null}
        {status === undefined ? null : (
          <span
            role={status.tone === "error" ? "alert" : "status"}
            className={`ml-auto min-w-0 truncate text-meta ${status.tone === "error" ? "text-error-text" : "text-fg-tertiary"}`}
          >
            {status.text}
          </span>
        )}
      </div>
    </SettingsCard>
  );
}
