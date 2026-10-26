import { Button } from "@base-ui/react/button";
import { Select as BaseSelect } from "@base-ui/react/select";
import { OFFERED_PROVIDERS, type ProviderId, type ThreadOverview } from "@cerium/protocol";
import type { AutomationRun, AutomationView } from "@cerium/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  CalendarClock,
  ChevronDown,
  CircleX,
  Eye,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  automationsAtom,
  deleteAutomation,
  pauseAutomation,
  runAutomation,
  saveAutomation,
} from "../../backend/automations.ts";
import { harnessesAtom, settingsAtom, threadsAtom } from "../../backend/atoms.ts";
import { gitBranchAtom } from "../../backend/projects.ts";
import { toThreadSummary } from "../../backend/view.ts";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { SelectItem, SelectPopup, SelectRoot } from "../../components/ui/Select.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useMinute } from "../../lib/useMinute.ts";
import { ModelPicker } from "../composer/ModelPicker.tsx";
import { accessLimit, accessOptions, effortFor, modelKey, pickModel, useModels } from "../composer/models.ts";
import { chipClass, type EffortPick } from "../composer/Pickers.tsx";
import { ProjectPicker, useLatestProject } from "../composer/ProjectPicker.tsx";
import { projectName } from "../composer/projectList.ts";
import { accessAtom, effortAtom, modelAtom } from "../settings/preferences.ts";
import type { ThreadSummary } from "../threads/model.ts";
import {
  draftOf,
  edited,
  inputOf,
  newDraft,
  pastLabel,
  repeatHint,
  repeatLabel,
  runCauseLabel,
  runState,
  runStateLabel,
  soonLabel,
  soonPhrase,
  whenLabel,
  type Draft,
  type Repeat,
  type RunState,
} from "./model.ts";

// The rail's Automations page: prompts that start a work thread on a schedule or when CI fails on a
// pushed commit. The list runs down the middle; the one picked, or a new one, opens beside it as a
// form with Run now, Pause and Delete, and the runs it made.

const useAutomations = (): ReadonlyArray<AutomationView> =>
  AsyncResult.getOrElse(useAtomValue(automationsAtom), (): ReadonlyArray<AutomationView> => []);

/** The machine's threads by id, to show how each run's thread is doing. */
const useThreads = (): ReadonlyMap<string, ThreadSummary> => {
  const overviews = AsyncResult.getOrElse(useAtomValue(threadsAtom), (): ReadonlyArray<ThreadOverview> => []);
  return new Map(overviews.map((overview) => [overview.thread.id, toThreadSummary(overview)]));
};

const stateTone: Record<RunState, string> = {
  working: "bg-running",
  needsYou: "bg-attention",
  done: "bg-success",
  failed: "bg-error",
  notStarted: "bg-error",
  skipped: "bg-line-strong",
};

const stateText: Record<RunState, string> = {
  working: "text-fg-secondary",
  needsYou: "text-attention",
  done: "text-fg-tertiary",
  failed: "text-error",
  notStarted: "text-error",
  skipped: "text-fg-tertiary",
};

const accentButton =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90 data-disabled:opacity-40 max-md:h-10 max-md:text-sm";

/** Each access mode's mark, as the message box's access menu shows it. */
const accessIcon: Partial<Record<Draft["access"], LucideIcon>> = {
  auto: ShieldCheck,
  readOnly: Eye,
  fullAccess: ShieldOff,
};

/** The page on a wide window: the list down the middle, and the picked automation beside it. */
export function AutomationsPage({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="flex h-full overflow-hidden rounded-xl border border-line-subtle bg-surface-pane shadow-raised">
      <ScrollArea className="flex-1">{list}</ScrollArea>
      {detail === null ? null : (
        <aside className="w-[min(440px,48%)] shrink-0 border-l border-line-subtle">{detail}</aside>
      )}
    </div>
  );
}

/** The machine's automations, oldest first, and the button that starts a new one. */
export function AutomationList({
  selected,
  onSelect,
  onNew,
}: {
  selected: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const views = useAutomations();
  const threads = useThreads();
  const now = useMinute();
  const on = views.filter((view) => !view.automation.paused).length;
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col px-6 pt-10 pb-12 max-md:px-3 max-md:pt-1">
      <header className="mb-5 flex items-end gap-3 px-1 max-md:mb-3 max-md:px-1.5">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[22px] leading-tight font-semibold font-stretch-expanded [font-size-adjust:none] max-md:text-[20px]">
            Automations
          </h1>
          <p className="mt-0.5 text-body text-fg-tertiary max-md:text-sm">
            {views.length === 0
              ? "Threads that start themselves"
              : on === views.length
                ? `${on} active`
                : `${on} active · ${views.length - on} paused`}
          </p>
        </div>
        <Button onClick={onNew} className={accentButton}>
          <Plus size={14} strokeWidth={2} />
          New
        </Button>
      </header>

      {views.length === 0 ? (
        <div className="mt-6 flex flex-col items-start gap-1 rounded-xl border border-dashed border-line-subtle px-5 py-6 text-body text-fg-tertiary">
          <p className="text-fg-secondary">Start a thread on a schedule, or when CI fails.</p>
          <p>It runs while Cerium is open or in the tray, and lands in your inbox.</p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {views.map((view) => (
            <AutomationRow
              key={view.automation.id}
              view={view}
              now={now}
              lastThread={lastThread(view.runs, threads)}
              selected={view.automation.id === selected}
              onSelect={() => onSelect(view.automation.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** An automation's latest run, with its thread where the window knows it. */
interface LastRun {
  readonly run: AutomationRun;
  readonly thread: ThreadSummary | undefined;
}

const lastThread = (
  runs: ReadonlyArray<AutomationRun>,
  threads: ReadonlyMap<string, ThreadSummary>,
): LastRun | undefined => {
  const run = runs[0];
  if (run === undefined) return undefined;
  return { run, thread: run.threadId === undefined ? undefined : threads.get(run.threadId) };
};

function AutomationRow({
  view,
  now,
  lastThread: last,
  selected,
  onSelect,
}: {
  view: AutomationView;
  now: number;
  lastThread: LastRun | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { automation, nextAt } = view;
  const Icon = automation.when._tag === "CiFailed" ? CircleX : CalendarClock;
  const state = last === undefined ? undefined : runState(last.run, last.thread);
  // When it goes off next, over how its last run went.
  const next = automation.paused
    ? "Paused"
    : nextAt !== undefined
      ? soonLabel(nextAt, now)
      : automation.when._tag === "CiFailed"
        ? "Watching CI"
        : "Waiting";
  return (
    <li>
      <Button
        onClick={onSelect}
        className={`flex min-h-14 w-full cursor-default items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors focus-visible:bg-surface-hover max-md:min-h-16 ${
          selected ? "bg-surface-selected" : "hover:bg-surface-hover"
        }`}
      >
        <span className="relative shrink-0">
          <Icon
            size={18}
            strokeWidth={1.75}
            className={automation.paused ? "text-fg-disabled" : "text-fg-tertiary"}
          />
          {state === "working" || state === "needsYou" ? (
            <span
              className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-surface-pane ${stateTone[state]}`}
            />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={`truncate text-reading max-md:text-[15px] ${automation.paused ? "text-fg-tertiary" : "text-fg-primary"}`}
          >
            {automation.name}
          </span>
          <span className="truncate text-meta text-fg-tertiary">
            {whenLabel(automation.when)} · {projectName(automation.project)}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          <span
            className={`flex items-center gap-1 text-meta tabular-nums ${automation.paused ? "text-fg-tertiary" : "text-fg-secondary"}`}
          >
            {automation.paused ? <Pause size={11} strokeWidth={2} /> : null}
            {next}
          </span>
          {state === undefined ? null : (
            <span className={`flex items-center gap-1.5 text-caption ${stateText[state]}`}>
              <span className={`size-1.5 rounded-full ${stateTone[state]}`} />
              {runStateLabel[state]}
            </span>
          )}
        </span>
      </Button>
    </li>
  );
}

/** A labelled group of the form. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-line-subtle pt-3.5">
      <h3 className="text-meta font-medium text-fg-tertiary max-md:text-[13px]">{label}</h3>
      {children}
    </section>
  );
}

/** A quiet select in the form's rows: the composer's chip, with a chevron. */
function ChipSelect({
  label,
  value,
  shown,
  icon: Icon,
  onPick,
  children,
}: {
  label: string;
  value: string;
  shown: ReactNode;
  icon?: LucideIcon;
  onPick: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <SelectRoot
      value={value}
      onValueChange={(picked: string | null) => {
        if (picked !== null) onPick(picked);
      }}
    >
      <BaseSelect.Trigger aria-label={label} className={`${chipClass} min-w-0 -ml-1 px-2`}>
        {Icon ? <Icon size={13} strokeWidth={1.75} className="shrink-0" /> : null}
        <span className="truncate">{shown}</span>
        <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-fg-tertiary" />
      </BaseSelect.Trigger>
      <SelectPopup>{children}</SelectPopup>
    </SelectRoot>
  );
}

const MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);
const twoDigits = (value: number) => String(value).padStart(2, "0");

/**
 * An automation's form: what it's called and asks, when it goes off, where and on what model it
 * runs; then its runs. A new one (`id` absent) saves as it's created; a saved one saves its changes.
 */
export function AutomationDetail({
  id,
  available,
  onClose,
  onCreated,
  onDeleted,
  onOpenThread,
}: {
  id: string | undefined;
  /** The harnesses that can run a thread now. */
  available: ReadonlySet<ProviderId>;
  /** Closes the form; none on a phone, whose bar has the way back. */
  onClose?: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const views = useAutomations();
  const view = id === undefined ? undefined : views.find((each) => each.automation.id === id);
  const models = useModels();
  const defaults = {
    project: useLatestProject(),
    model: useAtomValue(modelAtom),
    effort: useAtomValue(effortAtom),
    access: useAtomValue(accessAtom),
  };
  /** What the user changed; until then the form shows the automation as saved, or a new one's defaults. */
  const [draft, setDraft] = useState<Draft>();
  const base = draft ?? (view === undefined ? newDraft(defaults) : draftOf(view.automation));
  // The project, when it's still to be picked, follows the projects as they load.
  const shownDraft = base.project === undefined ? { ...base, project: defaults.project } : base;
  const [busy, setBusy] = useState<"save" | "run">();
  const [problem, setProblem] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [picking, setPicking] = useState(false);
  const save = useAtomSet(saveAutomation, { mode: "promise" });
  const pause = useAtomSet(pauseAutomation, { mode: "promise" });
  const remove = useAtomSet(deleteAutomation, { mode: "promise" });
  const run = useAtomSet(runAutomation, { mode: "promise" });
  const settings = useAtomValue(settingsAtom);
  const routerOn = AsyncResult.isSuccess(settings) && settings.value.effortRouter.enabled;
  const harnesses = AsyncResult.getOrElse(useAtomValue(harnessesAtom), () => []);
  const branch = AsyncResult.getOrElse(
    useAtomValue(gitBranchAtom(shownDraft.project ?? "")),
    () => undefined,
  );
  if (id !== undefined && view === undefined) return null;

  const model = pickModel(models, shownDraft.model ?? "", available);
  const limit = accessLimit(harnesses, model ? [model] : []);
  const effort: EffortPick | undefined =
    model === undefined || model.efforts.length === 0
      ? undefined
      : shownDraft.autoEffort && routerOn
        ? "auto"
        : effortFor(model, shownDraft.effort);
  const worktrees = branch !== undefined;
  const result = inputOf({ ...shownDraft, worktree: shownDraft.worktree && worktrees }, model);
  const dirty = edited(shownDraft, view?.automation);
  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...shownDraft, ...patch });
    setProblem(undefined);
  };

  const submit = () => {
    if (!("input" in result)) return;
    setBusy("save");
    save({ payload: { ...(id === undefined ? {} : { id }), input: result.input } })
      .then((saved) => {
        setDraft(undefined);
        if (id === undefined) onCreated(saved.id);
      })
      .catch((error: unknown) => setProblem(messageOf(error)))
      .finally(() => setBusy(undefined));
  };

  const runNow = () => {
    if (id === undefined) return;
    setBusy("run");
    run({ payload: { id } })
      .then((started) => {
        if (started.failed !== undefined && started.threadId === undefined) setProblem(started.failed);
      })
      .catch((error: unknown) => setProblem(messageOf(error)))
      .finally(() => setBusy(undefined));
  };

  const repeat = shownDraft.repeat;
  const paused = view?.automation.paused === true;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        {onClose ? <IconButton icon={X} label="Close" onClick={onClose} /> : null}
        <span className="ml-auto" />
        {view === undefined ? null : (
          <>
            <Tooltip
              label={
                view.automation.when._tag === "CiFailed"
                  ? "Start a thread now, with the project's latest CI failure"
                  : "Start a thread from it now"
              }
            >
              <Button
                onClick={runNow}
                disabled={busy !== undefined}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:opacity-50 max-md:h-10"
              >
                <Play size={13} strokeWidth={1.75} />
                Run now
              </Button>
            </Tooltip>
            <IconButton
              icon={paused ? Play : Pause}
              label={paused ? "Resume" : "Pause"}
              onClick={() => {
                void pause({ payload: { id: view.automation.id, paused: !paused } }).catch((error: unknown) =>
                  setProblem(messageOf(error)),
                );
              }}
              className="max-md:size-10"
            />
            <IconButton
              icon={Trash2}
              label="Delete automation"
              onClick={() => setDeleting(true)}
              className="max-md:size-10"
            />
          </>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 px-4 pb-6">
          <div className="flex flex-col gap-1">
            {paused ? <span className="text-meta font-medium text-attention">Paused</span> : null}
            <input
              value={shownDraft.name}
              onChange={(event) => edit({ name: event.target.value })}
              placeholder={id === undefined ? "New automation" : "Untitled"}
              aria-label="Name"
              maxLength={60}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- a new automation starts at its name
              autoFocus={id === undefined}
              className="-mx-2 rounded-md bg-transparent px-2 py-1 text-reading leading-snug font-medium text-fg-primary outline-none transition-colors placeholder:text-fg-tertiary hover:bg-surface-hover focus:bg-surface-hover max-md:text-[17px]"
            />
            <textarea
              value={shownDraft.prompt}
              onChange={(event) => edit({ prompt: event.target.value })}
              placeholder="What should the agent do each time?"
              aria-label="Prompt"
              maxLength={20_000}
              className="-mx-2 min-h-24 resize-none rounded-md bg-transparent px-2 py-1.5 text-body leading-relaxed text-fg-secondary outline-none transition-colors [field-sizing:content] placeholder:text-fg-tertiary hover:bg-surface-hover focus:bg-surface-hover focus:text-fg-primary max-md:text-[15px]"
            />
          </div>

          <Field label="When">
            <div className="flex flex-wrap items-center gap-1">
              <ChipSelect
                label="Repeats"
                value={repeat}
                shown={repeatLabel[repeat]}
                icon={repeat === "CiFailed" ? CircleX : CalendarClock}
                onPick={(picked) => edit({ repeat: picked as Repeat })}
              >
                {(["Hourly", "Daily", "Weekdays", "CiFailed"] as const).map((each) => (
                  <SelectItem key={each} value={each} description={repeatHint[each]}>
                    {repeatLabel[each]}
                  </SelectItem>
                ))}
              </ChipSelect>
              {repeat === "Hourly" ? (
                <ChipSelect
                  label="Minute past the hour"
                  value={String(shownDraft.minute)}
                  shown={`at :${twoDigits(shownDraft.minute)}`}
                  onPick={(picked) => edit({ minute: Number(picked) })}
                >
                  {MINUTES.map((minute) => (
                    <SelectItem key={minute} value={String(minute)}>
                      :{twoDigits(minute)}
                    </SelectItem>
                  ))}
                </ChipSelect>
              ) : repeat === "Daily" || repeat === "Weekdays" ? (
                <label className="flex h-8 items-center gap-1.5 rounded-full px-2 text-meta text-fg-secondary hover:bg-surface-hover">
                  at
                  <input
                    type="time"
                    value={`${twoDigits(Math.floor(shownDraft.at / 60))}:${twoDigits(shownDraft.at % 60)}`}
                    onChange={(event) => {
                      const [hours, minutes] = event.target.value.split(":").map(Number);
                      if (hours !== undefined && minutes !== undefined && !Number.isNaN(hours + minutes))
                        edit({ at: hours * 60 + minutes });
                    }}
                    aria-label="Time"
                    // The system's own clock glyph is hidden; a click anywhere on the time opens its picker.
                    onClick={(event) => event.currentTarget.showPicker?.()}
                    className="bg-transparent text-fg-primary tabular-nums outline-none [&::-webkit-calendar-picker-indicator]:hidden"
                  />
                </label>
              ) : null}
            </div>
            <p className="text-caption text-fg-tertiary">
              {repeat === "CiFailed"
                ? "When an agent pushes with Cerium and that commit's CI fails, a thread starts with the failed checks' logs."
                : "Runs while Cerium is open or in the tray. A time missed while it was closed runs once when it opens, unless the next is nearer."}
            </p>
          </Field>

          <Field label="Where">
            <div className="flex min-w-0 items-center">
              <div className="-ml-2 min-w-0">
                <ProjectPicker
                  folder={shownDraft.project}
                  onChoose={(folder) => edit({ project: folder })}
                  open={picking}
                  onOpenChange={setPicking}
                />
              </div>
              {worktrees ? (
                <>
                  <span aria-hidden className="text-meta text-fg-disabled">
                    /
                  </span>
                  <ChipSelect
                    label="Where agents work"
                    value={shownDraft.worktree ? "worktree" : "local"}
                    shown={shownDraft.worktree ? "New worktree each run" : branch}
                    icon={shownDraft.worktree ? GitBranchPlus : GitBranch}
                    onPick={(picked) => edit({ worktree: picked === "worktree" })}
                  >
                    <SelectItem
                      value="local"
                      icon={FolderGit2}
                      description={`In the project's folder, on whatever is checked out`}
                    >
                      Local
                    </SelectItem>
                    <SelectItem
                      value="worktree"
                      icon={GitBranchPlus}
                      description={`A branch of its own each run, from ${branch}`}
                    >
                      New worktree each run
                    </SelectItem>
                  </ChipSelect>
                </>
              ) : null}
            </div>
          </Field>

          <Field label="Agent">
            <div className="-ml-1 flex flex-wrap items-center gap-1">
              <ModelPicker
                models={models}
                shown={
                  model ? { provider: model.provider, label: model.label, key: modelKey(model) } : undefined
                }
                providers={OFFERED_PROVIDERS}
                available={available}
                {...(model !== undefined && effort !== undefined
                  ? {
                      effort: {
                        levels: model.efforts,
                        value: effort,
                        auto: routerOn,
                        onPick: (picked: EffortPick) =>
                          edit(
                            picked === "auto" ? { autoEffort: true } : { effort: picked, autoEffort: false },
                          ),
                      },
                      effortShown: effort,
                    }
                  : {})}
                onPick={(picked) => edit({ model: modelKey(picked) })}
              />
              <ChipSelect
                label="Access"
                value={shownDraft.access}
                shown={accessOptions.find((option) => option.value === shownDraft.access)?.label ?? "Auto"}
                {...(accessIcon[shownDraft.access] ? { icon: accessIcon[shownDraft.access] } : {})}
                onPick={(picked) => edit({ access: picked as Draft["access"] })}
              >
                {accessOptions.map((option) => {
                  const blocked = limit?.blocks.includes(option.value) === true;
                  return (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={blocked}
                      description={blocked ? limit?.reason : option.description}
                    >
                      {option.label}
                    </SelectItem>
                  );
                })}
              </ChipSelect>
            </div>
          </Field>

          {dirty ? (
            <div className="flex items-center justify-end gap-2">
              {problem ? <span className="mr-auto min-w-0 text-meta text-error">{problem}</span> : null}
              {view !== undefined ? (
                <Button
                  onClick={() => {
                    setDraft(undefined);
                    setProblem(undefined);
                  }}
                  className="h-8 rounded-lg px-3 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-10"
                >
                  Discard
                </Button>
              ) : null}
              <Tooltip
                label={"missing" in result ? result.missing : view === undefined ? "Create it" : "Save"}
              >
                <Button
                  onClick={submit}
                  disabled={"missing" in result || busy !== undefined}
                  focusableWhenDisabled
                  className={accentButton}
                >
                  {view === undefined ? "Create" : "Save"}
                </Button>
              </Tooltip>
            </div>
          ) : problem ? (
            <p className="text-meta text-error">{problem}</p>
          ) : null}

          {view === undefined ? null : <Runs view={view} onOpenThread={onOpenThread} />}
        </div>
      </ScrollArea>
      {view === undefined ? null : (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${view.automation.name}?`}
          description="It won't start any more threads. The threads it started stay."
          confirmLabel="Delete"
          onConfirm={() => {
            void remove({ payload: { id: view.automation.id } }).then(onDeleted, (error: unknown) =>
              setProblem(messageOf(error)),
            );
          }}
        />
      )}
    </div>
  );
}

/** The runs an automation made, newest first: each one's thread opens from its row. */
function Runs({ view, onOpenThread }: { view: AutomationView; onOpenThread: (threadId: string) => void }) {
  const threads = useThreads();
  const now = useMinute();
  return (
    <Field label={view.nextAt === undefined ? "Runs" : `Runs · next ${soonPhrase(view.nextAt, now)}`}>
      {view.runs.length === 0 ? (
        <p className="text-meta text-fg-tertiary">None yet.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {view.runs.map((run) => {
            const thread = run.threadId === undefined ? undefined : threads.get(run.threadId);
            const state = runState(run, thread);
            const why = run.skipped ?? run.failed;
            const row = (
              <>
                <span className={`mt-[7px] size-1.5 shrink-0 self-start rounded-full ${stateTone[state]}`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-body text-fg-primary">{runCauseLabel(run)}</span>
                    <span className={`ml-auto shrink-0 text-meta ${stateText[state]}`}>
                      {runStateLabel[state]}
                    </span>
                  </span>
                  <span className="truncate text-meta text-fg-tertiary">
                    {pastLabel(run.at, now)}
                    {run.threadId !== undefined && thread === undefined ? " · thread deleted" : ""}
                  </span>
                  {why === undefined ? null : (
                    <span className="mt-0.5 text-meta text-fg-tertiary">{why}</span>
                  )}
                </span>
              </>
            );
            return (
              <li key={run.id}>
                {thread === undefined ? (
                  <div className="flex gap-2.5 px-2 py-1.5">{row}</div>
                ) : (
                  <Button
                    onClick={() => onOpenThread(thread.id)}
                    className="flex w-full cursor-default gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                  >
                    {row}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Field>
  );
}

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "That didn't work; try again.";
