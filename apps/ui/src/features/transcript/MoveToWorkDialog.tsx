import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  OFFERED_PROVIDERS,
  type AccessMode,
  type ModelInfo,
  type ModelSpeed,
  type ProviderId,
  type ReasoningEffort,
} from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Eye,
  FilePen,
  FolderGit2,
  FolderOpen,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { settingsAtom } from "../../backend/atoms.ts";
import { shellBridge } from "../../backend/shell.ts";
import { Button, buttonClass } from "../../components/ui/Button.tsx";
import { dialogBackdropClass, dialogPopupClass, dialogTitleClass } from "../../components/ui/FormDialog.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { accessOptions, effortFor, modelKey, pickModel, speedFor, useModels } from "../composer/models.ts";
import { ModelPicker } from "../composer/ModelPicker.tsx";
import { pathTail } from "../git/workspace.ts";
import { accessAtom, effortAtom, modelAtom, speedAtom, workplaceAtom } from "../settings/preferences.ts";

export interface MoveToWorkChoice {
  readonly cwd: string;
  readonly worktree?: boolean;
  readonly lead: {
    readonly provider: ProviderId;
    readonly model: string;
    readonly effort?: ReasoningEffort;
    readonly autoEffort?: boolean;
    readonly speed?: ModelSpeed;
    readonly access: AccessMode;
  };
  readonly implement?: {
    readonly message?: string;
    readonly note?: string;
  };
}

export interface MoveToWorkActions {
  readonly projects: ReadonlyArray<string>;
  readonly defaultFolder?: string | undefined;
  readonly available: ReadonlySet<ProviderId>;
  readonly worktrees: boolean;
  readonly onMove: (choice: MoveToWorkChoice) => Promise<void>;
}

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

const row =
  "group flex w-full cursor-default items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors select-none hover:bg-surface-hover focus-visible:bg-surface-hover data-checked:bg-surface-selected max-md:py-2.5";

const mark =
  "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors group-data-checked:border-accent group-data-checked:bg-accent group-focus-visible:border-fg-secondary";

function Heading({ children }: { children: string }) {
  return <h3 className="text-caption font-medium text-fg-tertiary select-none">{children}</h3>;
}

/**
 * Moves an existing chat thread into a project as a work thread, letting the user pick the project,
 * workspace (local or worktree), model combo (model, effort, speed), access mode, and optional
 * implementation instructions.
 */
export function MoveToWorkDialog({
  open,
  onOpenChange,
  message,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The clicked user or agent message when opened via "Implement in work". */
  message?: string | undefined;
  actions: MoveToWorkActions;
}) {
  const models = useModels();
  const settings = useAtomValue(settingsAtom);
  const routerOn = AsyncResult.isSuccess(settings) && settings.value.effortRouter.enabled;
  const defaultWorkModel = useAtomValue(modelAtom);
  const defaultWorkEffort = useAtomValue(effortAtom);
  const defaultWorkSpeed = useAtomValue(speedAtom);
  const defaultWorkAccess = useAtomValue(accessAtom);
  const defaultWorkplace = useAtomValue(workplaceAtom);

  const initialFolder = actions.defaultFolder ?? actions.projects[0] ?? "";
  const [folder, setFolder] = useState(initialFolder);
  const [workspace, setWorkspace] = useState<"local" | "worktree">(
    actions.worktrees ? defaultWorkplace : "local",
  );
  const [pickedModel, setPickedModel] = useState<ModelInfo>();
  const [effort, setEffort] = useState<ReasoningEffort>(defaultWorkEffort);
  const [autoEffort, setAutoEffort] = useState(routerOn);
  const [speed, setSpeed] = useState<ModelSpeed | undefined>(defaultWorkSpeed);
  const [access, setAccess] = useState<AccessMode>(defaultWorkAccess);
  const [note, setNote] = useState("");
  const [startNow, setStartNow] = useState(message !== undefined);
  const [moving, setMoving] = useState(false);
  const [failure, setFailure] = useState<string>();

  const defaultPicked = pickModel(models, defaultWorkModel, actions.available);
  const target = pickedModel ?? defaultPicked;
  const activeEffort = target ? effortFor(target, effort) : undefined;
  const activeSpeed = target ? speedFor(target, speed) : undefined;
  const accessOption = accessOptions.find((option) => option.value === access);

  const folders = [...new Set([folder, ...actions.projects].filter((each) => each !== ""))];
  const canBrowse = shellBridge()?.pickFolder !== undefined;

  const browse = async () => {
    const picked = await shellBridge()?.pickFolder?.();
    if (picked) setFolder(picked);
  };

  const reset = () => {
    setFailure(undefined);
    setFolder(actions.defaultFolder ?? actions.projects[0] ?? "");
    setWorkspace(actions.worktrees ? defaultWorkplace : "local");
    setPickedModel(undefined);
    setEffort(defaultWorkEffort);
    setAutoEffort(routerOn);
    setSpeed(defaultWorkSpeed);
    setAccess(defaultWorkAccess);
    setNote("");
    setStartNow(message !== undefined);
  };

  const submit = () => {
    if (!folder || !target) return;
    setMoving(true);
    setFailure(undefined);
    const trimmedNote = note.trim();
    const shouldImplement = startNow || trimmedNote !== "";
    actions
      .onMove({
        cwd: folder,
        ...(actions.worktrees && workspace === "worktree" ? { worktree: true } : {}),
        lead: {
          provider: target.provider,
          model: target.id,
          ...(activeEffort ? { effort: activeEffort } : {}),
          ...(routerOn && autoEffort ? { autoEffort: true } : {}),
          ...(activeSpeed ? { speed: activeSpeed } : {}),
          access,
        },
        ...(shouldImplement
          ? {
              implement: {
                ...(message !== undefined && message.trim() !== "" ? { message: message.trim() } : {}),
                ...(trimmedNote !== "" ? { note: trimmedNote } : {}),
              },
            }
          : {}),
      })
      .then(
        () => {
          setMoving(false);
          onOpenChange(false);
        },
        (error: unknown) => {
          setMoving(false);
          setFailure(error instanceof Error ? error.message : String(error));
        },
      );
  };

  const isImplement = message !== undefined;

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (moving) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={dialogBackdropClass} />
        <AlertDialog.Popup className={`${dialogPopupClass("md")} flex flex-col gap-4`}>
          <div className="flex flex-col gap-2">
            <AlertDialog.Title className={dialogTitleClass}>
              {isImplement ? "Implement in work" : "Move chat to work"}
            </AlertDialog.Title>
            {isImplement ? (
              <AlertDialog.Description className="line-clamp-3 border-l-2 border-line-strong pl-2.5 text-body leading-relaxed text-fg-secondary">
                {message.trim() === "" ? "(empty message)" : message.trim()}
              </AlertDialog.Description>
            ) : null}
            <p className="text-meta text-fg-tertiary">
              Moves this exact chat into a work thread in the chosen project, carries the full conversation,
              and lets the agent know it now has workspace tools.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Heading>Project</Heading>
            <div className="flex items-center gap-2">
              {folders.length > 0 ? (
                <SelectRoot
                  value={folder}
                  onValueChange={(next) => {
                    if (next !== null) setFolder(next);
                  }}
                >
                  <SelectTrigger label="Project">
                    <span className="flex min-w-0 items-center gap-1.5 truncate">
                      <FolderGit2 size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
                      <span className="truncate">{folder ? pathTail(folder) : "Choose a project"}</span>
                    </span>
                  </SelectTrigger>
                  <SelectPopup>
                    {folders.map((each) => (
                      <SelectItem key={each} value={each} icon={FolderGit2} description={each}>
                        {pathTail(each)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </SelectRoot>
              ) : (
                <span className="text-meta text-fg-tertiary">No saved projects yet.</span>
              )}
              {canBrowse ? (
                <Button onClick={() => void browse()} className="shrink-0">
                  <FolderOpen size={13} strokeWidth={1.75} />
                  Browse…
                </Button>
              ) : null}
            </div>
          </div>

          {actions.worktrees ? (
            <div className="flex flex-col gap-1">
              <Heading>Workspace</Heading>
              <RadioGroup
                aria-label="Workspace"
                value={workspace}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree") setWorkspace(value);
                }}
                className="-mx-1 flex flex-col"
              >
                <Radio.Root value="local" className={row}>
                  <span className={mark}>
                    <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg data-unchecked:hidden" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-medium text-fg-primary">Local folder</span>
                    <span className="truncate text-meta text-fg-tertiary" title={folder}>
                      {folder
                        ? `Works directly in ${pathTail(folder)}`
                        : "Works directly in the project folder"}
                    </span>
                  </span>
                </Radio.Root>
                <Radio.Root value="worktree" className={row}>
                  <span className={mark}>
                    <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg data-unchecked:hidden" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-medium text-fg-primary">New worktree</span>
                    <span className="text-meta text-fg-tertiary">
                      Creates an isolated git branch and checkout for this work
                    </span>
                  </span>
                </Radio.Root>
              </RadioGroup>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Heading>Model combo</Heading>
              {target ? (
                <ModelPicker
                  variant="select"
                  ariaLabel="Model combo"
                  models={models}
                  providers={OFFERED_PROVIDERS}
                  available={actions.available}
                  shown={{ provider: target.provider, label: target.label, key: modelKey(target) }}
                  effort={
                    target.efforts.length > 0
                      ? {
                          levels: target.efforts,
                          value: activeEffort ?? effort,
                          onPick: setEffort,
                          ...(routerOn ? { auto: { on: autoEffort, onToggle: setAutoEffort } } : {}),
                        }
                      : undefined
                  }
                  effortShown={routerOn && autoEffort ? "auto" : activeEffort}
                  speed={
                    (target.speeds?.length ?? 0) > 0
                      ? {
                          speeds: target.speeds ?? [],
                          value: activeSpeed ?? "standard",
                          onPick: setSpeed,
                        }
                      : undefined
                  }
                  speedShown={activeSpeed}
                  onPick={setPickedModel}
                />
              ) : (
                <span className="text-meta text-fg-tertiary">No model available.</span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Heading>Access</Heading>
              <SelectRoot
                value={access}
                onValueChange={(next) => {
                  if (next !== null) setAccess(next);
                }}
              >
                <SelectTrigger label="Access">
                  <span>{accessOption?.label ?? access}</span>
                </SelectTrigger>
                <SelectPopup>
                  {accessOptions.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      icon={accessIcon[option.value]}
                      description={option.description}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </SelectRoot>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Heading>Instructions (optional)</Heading>
            <textarea
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                isImplement
                  ? "Extra guidance for the agent (leave blank to implement as discussed)…"
                  : "Optional message to send right after moving to work…"
              }
              className="w-full resize-none rounded-lg border border-line-subtle bg-surface-raised px-2.5 py-2 text-body text-fg-primary placeholder:text-fg-tertiary focus:border-focus-ring focus:outline-none"
            />
            <label className="flex cursor-pointer items-center gap-2 text-meta text-fg-secondary select-none">
              <input
                type="checkbox"
                checked={startNow || note.trim() !== ""}
                disabled={note.trim() !== ""}
                onChange={(event) => setStartNow(event.target.checked)}
                className="size-3.5 rounded accent-accent"
              />
              Start implementing immediately after moving
            </label>
          </div>

          {failure ? (
            <p role="alert" className="text-body text-error-text">
              {failure}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <AlertDialog.Close disabled={moving} className={buttonClass()}>
              Cancel
            </AlertDialog.Close>
            <Button tone="primary" disabled={moving || !folder || !target} onClick={submit}>
              {moving ? "Moving…" : startNow || note.trim() !== "" ? "Implement in work" : "Move to work"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
