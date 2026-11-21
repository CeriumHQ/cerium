import type {
  HubInstructionFile,
  HubInstructionMode,
  HubInstructionOutcome,
  HubInstructionStatus,
} from "@cerium/protocol";
import { Button } from "@base-ui/react/button";
import { Checkbox } from "@base-ui/react/checkbox";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Check, CircleAlert, CornerDownRight, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { hubInstructionsAtom, hubInstructionsKey, syncHubInstructions } from "../../backend/hub.ts";
import { machineAtom, machineKey } from "../../backend/machine.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { buttonClass } from "../../components/ui/Button.tsx";
import { checkBoxClass, checkMarkClass } from "../../components/ui/Checkbox.tsx";
import { Disclosure } from "../../components/ui/Disclosure.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { segmentedTrackClass } from "../../components/ui/Segmented.tsx";
import { remember, stored } from "../../lib/storage.ts";
import { harnessName } from "./Harnesses.tsx";
import {
  canBeCanonical,
  defaultInstructionSource,
  instructionSync,
  instructionTarget,
  isStaleInstructionDraft,
  type InstructionDraft,
  type InstructionSelection,
} from "./hubInstructionsModel.ts";
import { SettingsCard, SettingsNote } from "./parts.tsx";

const statuses: Record<HubInstructionStatus, string> = {
  canonical: "Canonical",
  inSync: "In sync",
  linked: "Linked",
  missing: "Missing",
  diverged: "Diverged",
  unavailable: "Unavailable",
};

/** How each status reads at a glance: settled ones quiet or green, ones that want a look in amber. */
const statusTone: Record<HubInstructionStatus | "supplemental", string> = {
  canonical: "border-transparent bg-accent-soft text-fg-primary",
  inSync: "border-success/35 text-success-text",
  linked: "border-success/35 text-success-text",
  missing: "border-line-subtle text-fg-tertiary",
  diverged: "border-attention/40 text-attention-text",
  unavailable: "border-error/35 text-error-text",
  supplemental: "border-line-subtle text-fg-tertiary",
};

const resultTone: Record<HubInstructionOutcome["result"], string> = {
  unchanged: "text-fg-tertiary",
  copied: "text-success-text",
  linked: "text-success-text",
  skipped: "text-attention-text",
};

const results: Record<HubInstructionOutcome["result"], string> = {
  unchanged: "Already synced",
  copied: "Copied",
  linked: "Linked",
  skipped: "Skipped",
};

const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "The project instructions could not be read or saved.";

export function HubInstructions({ project }: { project: string }) {
  const machine = useAtomValue(machineAtom);
  const sourceKey = machineKey(`cerium:instruction-source:${JSON.stringify(project)}`, machine);
  return (
    <ProjectInstructions key={sourceKey} project={project} machine={machine?.id} sourceKey={sourceKey} />
  );
}

function ProjectInstructions({
  project,
  machine,
  sourceKey,
}: {
  project: string;
  machine: string | undefined;
  sourceKey: string;
}) {
  const atom = hubInstructionsAtom(hubInstructionsKey(machine, project));
  const state = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const files = AsyncResult.getOrElse(state, () => undefined);
  const error = AsyncResult.isFailure(state) ? messageOf(Cause.squash(state.cause)) : undefined;
  if (files === undefined) {
    if (error !== undefined) {
      return (
        <div className="flex flex-col items-start gap-3">
          <SettingsNote tone="error">
            <span role="alert">{error}</span>
          </SettingsNote>
          <Button onClick={refresh} className={buttonClass({ size: "sm" })}>
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden />
            Read again
          </Button>
        </div>
      );
    }
    return (
      <SettingsNote>
        <output className="flex items-center gap-2">
          <LoaderCircle size={14} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
          Reading project instructions…
        </output>
      </SettingsNote>
    );
  }
  return (
    <InstructionEditor
      project={project}
      files={files}
      sourceKey={sourceKey}
      refresh={refresh}
      waiting={state.waiting}
      readError={error}
    />
  );
}

function InstructionEditor({
  project,
  files,
  sourceKey,
  refresh,
  waiting,
  readError,
}: {
  project: string;
  files: ReadonlyArray<HubInstructionFile>;
  sourceKey: string;
  refresh: () => void;
  waiting: boolean;
  readError: string | undefined;
}) {
  const sync = useAtomSet(syncHubInstructions, { mode: "promise" });
  const [picked, setPicked] = useState(() => stored(sourceKey));
  const [draft, setDraft] = useState<InstructionDraft>();
  const [selected, setSelected] = useState<ReadonlyMap<string, InstructionSelection>>(() => new Map());
  const [mode, setMode] = useState<HubInstructionMode>("copy");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    { error: string } | { outcomes: ReadonlyArray<HubInstructionOutcome> }
  >();

  const canonical =
    (picked === undefined ? undefined : files.find((file) => file.path === picked)) ??
    defaultInstructionSource(files);
  const editable = canonical !== undefined && canBeCanonical(canonical);
  const staleDraft = isStaleInstructionDraft(draft, canonical);
  const staleTargets = [...selected].some(([path, selection]) => {
    const file = files.find((entry) => entry.path === path);
    return file === undefined || instructionTarget(file, canonical, selection).stale;
  });
  const payload = instructionSync(project, files, canonical, draft, selected, mode);
  const canSubmit = payload !== undefined && !waiting && !busy && readError === undefined;

  const save = () => {
    if (!canSubmit || payload === undefined) return;
    remember(sourceKey, payload.source.path);
    setPicked(payload.source.path);
    setBusy(true);
    setNotice(undefined);
    sync({ payload }).then(
      (outcomes) => {
        setDraft(undefined);
        setSelected(new Map());
        setNotice({ outcomes });
        refresh();
        setBusy(false);
      },
      (error: unknown) => {
        setNotice({ error: messageOf(error) });
        refresh();
        setBusy(false);
      },
    );
  };

  const locked = busy || waiting;
  const ids = useId();
  const choose = (file: string) => {
    remember(sourceKey, file);
    setPicked(file);
    setDraft(undefined);
    setSelected(new Map());
    setNotice(undefined);
  };
  const choices = [
    ...(canonical !== undefined && !editable ? [canonical] : []),
    ...files.filter(canBeCanonical),
  ];

  return (
    <div className="flex flex-col gap-7 md:gap-8">
      <fieldset
        disabled={locked}
        aria-labelledby={`${ids}-canonical`}
        className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0"
      >
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={`${ids}-canonical`} className="text-body font-medium text-fg-primary">
              Canonical instructions
            </h2>
            <p className="text-meta leading-relaxed text-fg-tertiary">
              The file you edit here. The harnesses' own files are synced from it.
            </p>
          </div>
          <SelectRoot
            value={canonical?.path ?? null}
            onValueChange={(next: string | null) => next !== null && choose(next)}
            disabled={locked}
          >
            <SelectTrigger label="Canonical file">
              {canonical === undefined ? (
                <span>Choose a file</span>
              ) : (
                <>
                  <FileIcon path={canonical.path} className="size-3.5 shrink-0" />
                  <span className="max-w-56 truncate font-mono">{canonical.path}</span>
                </>
              )}
            </SelectTrigger>
            <SelectPopup side="bottom">
              {choices.map((file) => (
                <SelectItem
                  key={file.path}
                  value={file.path}
                  disabled={!canBeCanonical(file)}
                  {...(file.providers.length > 0
                    ? { description: file.providers.map((provider) => harnessName[provider]).join(", ") }
                    : {})}
                >
                  <span className="font-mono">{file.path}</span>
                </SelectItem>
              ))}
            </SelectPopup>
          </SelectRoot>
        </div>
        {canonical !== undefined && editable ? (
          <SettingsCard className="overflow-hidden focus-within:border-line-strong">
            <label className="block">
              <span className="sr-only">Instruction text</span>
              <textarea
                rows={12}
                spellCheck={false}
                value={draft?.content ?? canonical.content ?? ""}
                placeholder="# Instructions for every agent in this project"
                onChange={(event) =>
                  setDraft({
                    content: event.currentTarget.value,
                    path: draft?.path ?? canonical.path,
                    revision: draft?.revision ?? canonical.revision,
                  })
                }
                className="block max-h-[60vh] min-h-64 w-full resize-y bg-transparent px-4 py-3 font-mono text-meta leading-relaxed text-fg-primary outline-none [field-sizing:content] placeholder:text-fg-tertiary disabled:text-fg-tertiary max-md:text-[13px]"
              />
            </label>
            <div className="flex h-8 items-center gap-2 border-t border-line-subtle bg-surface-sunken/50 px-4 text-caption text-fg-tertiary">
              <FileIcon path={canonical.path} className="size-3 shrink-0" />
              <span className="min-w-0 truncate font-mono">{canonical.path}</span>
              {draft !== undefined && !staleDraft ? (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-fg-secondary">
                  <span aria-hidden className="size-1.5 rounded-full bg-attention" />
                  Unsaved changes
                </span>
              ) : null}
            </div>
          </SettingsCard>
        ) : (
          <SettingsNote>Choose an available project instruction file to edit or sync.</SettingsNote>
        )}
        {staleDraft ? (
          <InlineAlert
            action={
              <Button onClick={() => setDraft(undefined)} className={buttonClass({ size: "sm" })}>
                Load current text
              </Button>
            }
          >
            The canonical file changed while you were editing.
          </InlineAlert>
        ) : null}
      </fieldset>

      <fieldset
        disabled={locked}
        aria-labelledby={`${ids}-files`}
        className="m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0"
      >
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={`${ids}-files`} className="text-body font-medium text-fg-primary">
              Harness instruction files
            </h2>
            <p className="text-meta leading-relaxed text-fg-tertiary">
              {mode === "copy"
                ? "Pick the files to write the canonical text into."
                : "Pick the files to point at the canonical file, so they follow it from now on."}
            </p>
          </div>
          <ToggleGroup
            value={[mode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "copy" || next === "link") setMode(next);
            }}
            disabled={locked}
            aria-label="Sync method"
            className={`${segmentedTrackClass} shrink-0`}
          >
            {(
              [
                ["copy", "Copy text"],
                ["link", "Link"],
              ] as const
            ).map(([value, label]) => (
              <Toggle
                key={value}
                value={value}
                aria-label={value === "link" ? "Link to canonical file" : undefined}
                className="rounded-md px-2 py-0.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[14px]"
              >
                {label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        <SettingsCard>
          <ul className="flex flex-col divide-y divide-line-subtle">
            {files.map((file) => {
              const selection = selected.get(file.path);
              const target = instructionTarget(file, canonical, selection);
              const supplemental = file.supplemental && target.status !== "unavailable";
              return (
                <li key={file.path} className="flex flex-col gap-2 px-4 py-2.5">
                  <div className="flex min-h-6 min-w-0 items-center gap-2.5">
                    {target.selectable ? (
                      <Checkbox.Root
                        checked={target.selected}
                        disabled={locked}
                        aria-label={`Sync ${file.path}`}
                        onCheckedChange={(checked) => {
                          const next = new Map(selected);
                          if (checked && canonical !== undefined) {
                            next.set(file.path, {
                              revision: file.revision,
                              sourceRevision: canonical.revision,
                              sourcePath: canonical.path,
                              replace: false,
                            });
                          } else next.delete(file.path);
                          setSelected(next);
                        }}
                        className={`${checkBoxClass} cursor-default`}
                      >
                        <Checkbox.Indicator className="data-unchecked:hidden">
                          <Check size={10} strokeWidth={3} />
                        </Checkbox.Indicator>
                      </Checkbox.Root>
                    ) : (
                      <span aria-hidden className="size-3.5 shrink-0" />
                    )}
                    <FileIcon path={file.path} className="size-3.5 shrink-0" />
                    <code className="min-w-0 truncate font-mono text-meta text-fg-primary" title={file.path}>
                      {file.path}
                    </code>
                    {file.providers.length > 0 ? (
                      <span className="flex shrink-0 items-center gap-1">
                        {file.providers.map((provider) => (
                          <span
                            key={provider}
                            title={harnessName[provider]}
                            className="grid place-items-center"
                          >
                            <ProviderLogo provider={provider} size={12} />
                            <span className="sr-only">{harnessName[provider]}</span>
                          </span>
                        ))}
                      </span>
                    ) : null}
                    <span
                      className={`ml-auto shrink-0 rounded border px-1.5 text-caption leading-4 ${
                        statusTone[supplemental ? "supplemental" : target.status]
                      }`}
                    >
                      {supplemental ? "Supplemental rule" : statuses[target.status]}
                    </span>
                  </div>
                  {file.reference === undefined && file.problem === undefined ? null : (
                    <div className="flex flex-col gap-1 pl-12 text-caption max-md:text-[12px]">
                      {file.reference === undefined ? null : (
                        <span className="flex min-w-0 items-center gap-1 text-fg-tertiary">
                          <CornerDownRight size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
                          <span className="shrink-0">Reads</span>
                          <code className="min-w-0 truncate font-mono text-fg-secondary">
                            {file.reference}
                          </code>
                        </span>
                      )}
                      {file.problem === undefined ? null : (
                        <p className="flex items-start gap-1 text-error-text">
                          <CircleAlert
                            size={11}
                            strokeWidth={1.75}
                            aria-hidden
                            className="mt-[2.5px] shrink-0"
                          />
                          {file.problem}
                        </p>
                      )}
                    </div>
                  )}
                  {file.content !== undefined && file.path !== canonical?.path ? (
                    <Disclosure
                      summary="Preview"
                      hint={`View instructions in ${file.path}`}
                      className="pl-11"
                    >
                      <pre className="scroll-thin max-h-56 overflow-auto rounded-lg bg-surface-sunken p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap text-fg-secondary select-text">
                        {file.content}
                      </pre>
                    </Disclosure>
                  ) : null}
                  {target.confirm && selection !== undefined ? (
                    <div className="ml-12 rounded-lg border border-attention/30 bg-attention/6 px-2.5 py-2">
                      <Checkbox.Root
                        checked={selection.replace}
                        disabled={locked}
                        onCheckedChange={(checked) =>
                          setSelected(
                            new Map(selected).set(file.path, {
                              ...selection,
                              replace: checked,
                            }),
                          )
                        }
                        className="group flex cursor-default items-start gap-2 text-left text-meta text-fg-secondary outline-none select-none max-md:text-[13px]"
                      >
                        <span className={`${checkMarkClass} mt-px`}>
                          <Checkbox.Indicator className="data-unchecked:hidden">
                            <Check size={10} strokeWidth={3} />
                          </Checkbox.Indicator>
                        </span>
                        <span>
                          Replace the differing instructions in{" "}
                          <code className="font-mono text-fg-primary">{file.path}</code>
                          <span className="block text-caption text-fg-tertiary">
                            Its own text is overwritten. Preview it first to keep anything it adds.
                          </span>
                        </span>
                      </Checkbox.Root>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SettingsCard>
        {staleTargets ? (
          <InlineAlert
            action={
              <Button onClick={() => setSelected(new Map())} className={buttonClass({ size: "sm" })}>
                Clear selections
              </Button>
            }
          >
            A selected file or the canonical file changed. Review the current instructions before selecting it
            again.
          </InlineAlert>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {locked ? (
            <output className="flex min-w-0 items-center gap-2 text-meta text-fg-tertiary">
              <LoaderCircle size={13} strokeWidth={1.75} aria-hidden className="shrink-0 animate-spin" />
              {busy ? "Saving instructions…" : "Reading instructions…"}
            </output>
          ) : selected.size > 0 ? (
            <span className="text-meta text-fg-tertiary tabular-nums">
              {selected.size} {selected.size === 1 ? "file" : "files"} to{" "}
              {mode === "copy" ? "copy into" : "link"}
            </span>
          ) : null}
          <span className="flex-1" />
          <Button onClick={refresh} disabled={locked} className={buttonClass({ tone: "quiet", size: "sm" })}>
            <RefreshCw size={13} strokeWidth={1.75} aria-hidden className={waiting ? "animate-spin" : ""} />
            Read again
          </Button>
          <Button
            onClick={save}
            disabled={!canSubmit}
            className={buttonClass({ tone: "primary", size: "sm" })}
          >
            {selected.size === 0 ? "Save canonical file" : "Sync selected files"}
          </Button>
        </div>
        {readError !== undefined ? (
          <SettingsNote tone="error">
            <span role="alert">{readError}</span>
          </SettingsNote>
        ) : null}
        {notice && "error" in notice ? (
          <SettingsNote tone="error">
            <span role="alert">{notice.error}</span>
          </SettingsNote>
        ) : null}
        {notice && "outcomes" in notice ? (
          notice.outcomes.length === 0 ? (
            <output className="flex items-center gap-1.5 self-end text-meta text-success-text">
              <Check size={13} strokeWidth={2} aria-hidden />
              Canonical instructions saved.
            </output>
          ) : (
            <SettingsCard>
              <ul
                aria-label="Sync results"
                aria-live="polite"
                className="flex flex-col divide-y divide-line-subtle"
              >
                {notice.outcomes.map((outcome) => (
                  <li
                    key={outcome.path}
                    className="flex min-h-9 min-w-0 items-center gap-2.5 px-4 py-1.5 text-meta"
                  >
                    <span className={`shrink-0 ${resultTone[outcome.result]}`}>
                      {outcome.result === "skipped" ? (
                        <TriangleAlert size={13} strokeWidth={1.75} aria-hidden />
                      ) : (
                        <Check size={13} strokeWidth={2} aria-hidden />
                      )}
                    </span>
                    <code className="min-w-0 truncate font-mono text-fg-primary">{outcome.path}</code>
                    <span className={`shrink-0 ${resultTone[outcome.result]}`}>
                      · {results[outcome.result]}
                    </span>
                    {outcome.problem ? (
                      <span className="min-w-0 truncate text-fg-tertiary" title={outcome.problem}>
                        · {outcome.problem}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </SettingsCard>
          )
        ) : null}
      </div>
    </div>
  );
}

/** Something about the form that wants seeing to before it's sent, with the way to fix it. */
function InlineAlert({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-attention/30 bg-attention/6 px-3 py-2"
    >
      <TriangleAlert size={13} strokeWidth={2} aria-hidden className="shrink-0 text-attention-text" />
      <p className="min-w-0 flex-1 text-meta leading-relaxed text-fg-secondary max-md:text-[13px]">
        {children}
      </p>
      {action}
    </div>
  );
}
