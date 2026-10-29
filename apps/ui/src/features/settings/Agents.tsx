import { Button } from "@base-ui/react/button";
import type { AccessMode, ModelInfo, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronRight,
  Eye,
  FilePen,
  FolderGit2,
  GitBranchPlus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";

import { accountAtom, modelsAtom } from "../../backend/atoms.ts";
import { machineAtom } from "../../backend/machine.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { accessOptions, effortFor, effortLabel, modelKey, pickModel, useModels } from "../composer/models.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { ModelGroups, readyProviders } from "./ModelGroups.tsx";
import {
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsTag,
} from "./parts.tsx";
import { accessAtom, effortAtom, modelAtom, workplaceAtom } from "./preferences.ts";
import { RosterSection } from "./Roster.tsx";
import { TitleRows } from "./Titles.tsx";
import { AdvisorRows } from "./Advisor.tsx";

const effortHint: Record<ReasoningEffort, string> = {
  minimal: "Answers almost at once",
  low: "Quick answers for simple tasks",
  medium: "A balance of speed and depth",
  high: "Thinks problems through first",
  xhigh: "Takes its time on hard problems",
  max: "As long as the model allows: slowest and costliest",
};

/** The first backend that keeps a roster; an older one leads from every model its harnesses offer. */
const ROSTER_VERSION = 27;

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

const workplaces = {
  local: { label: "Local", description: "In the project's folder, on its branch" },
  worktree: { label: "Worktree", description: "A branch of its own, in a worktree" },
} as const;

/** The models the harnesses offer, and the one new threads start with, as the composer picks it. */
function useLeadModel(harnesses: ReadonlyArray<HarnessIndicator>) {
  const [modelId, setModelId] = useAtom(modelAtom);
  const models = useModels();
  return { models, model: pickModel(models, modelId, readyProviders(harnesses)), setModelId };
}

/**
 * What every new thread starts with, each changed for one thread in its composer: the model, its
 * effort, the access agents have, where a work thread runs, and its name.
 */
export function ThreadSettings({
  harnesses,
  onOpen,
}: {
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Opens the harnesses page, while none can run. */
  onOpen?: () => void;
}) {
  const { models, model, setModelId } = useLeadModel(harnesses);
  const [effort, setEffort] = useAtom(effortAtom);
  const [access, setAccess] = useAtom(accessAtom);
  const [workplace, setWorkplace] = useAtom(workplaceAtom);
  // Like the composer, a level the model lacks reads as its default or strongest one.
  const activeEffort = model ? effortFor(model, effort) : undefined;
  const accessOption = accessOptions.find((option) => option.value === access);

  return (
    <SettingsPage
      perMachine
      title="New threads"
      description="What every thread starts with. The message box changes any of it for one thread."
    >
      <SettingsSection title="Model">
        <SettingsList>
          <SettingsRow
            label="Default model"
            hint={model?.description}
            className="pr-2.5"
            control={() => (
              <ModelSelect
                value={model}
                onChange={setModelId}
                models={models}
                harnesses={harnesses}
                {...(onOpen ? { onOpenHarnesses: onOpen } : {})}
              />
            )}
          />
          {model && activeEffort ? (
            <SettingsRow
              label="Reasoning effort"
              hint={effortHint[activeEffort]}
              className="pr-2.5"
              control={() => (
                <SelectRoot value={activeEffort} onValueChange={(next) => next !== null && setEffort(next)}>
                  <SelectTrigger label="Reasoning effort">
                    <span>{effortLabel[activeEffort]}</span>
                  </SelectTrigger>
                  <SelectPopup>
                    {model.efforts.map((level) => (
                      <SelectItem key={level} value={level} description={effortHint[level]}>
                        {effortLabel[level]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </SelectRoot>
              )}
            />
          ) : null}
        </SettingsList>
      </SettingsSection>

      <SettingsSection title="Workspace">
        <SettingsList>
          <SettingsRow
            label="Access"
            hint={`${accessOption?.description ?? ""}. Chats are always read only.`}
            className="pr-2.5"
            control={() => (
              <SelectRoot value={access} onValueChange={(next) => next !== null && setAccess(next)}>
                <SelectTrigger label="Access">
                  <span>{accessOption?.label}</span>
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
            )}
          />
          <SettingsRow
            label="Where work threads run"
            hint={`In a git project: ${workplaces[workplace].description.toLowerCase()}`}
            className="pr-2.5"
            control={() => (
              <SelectRoot value={workplace} onValueChange={(next) => next !== null && setWorkplace(next)}>
                <SelectTrigger label="Where new work threads run">
                  {workplaces[workplace].label}
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
        </SettingsList>
      </SettingsSection>

      <SettingsSection title="Titles">
        <SettingsList>
          <TitleRows models={models} harnesses={harnesses} />
        </SettingsList>
      </SettingsSection>
    </SettingsPage>
  );
}

/** The models a lead may start without asking; a backend too old to keep a roster says so. */
export function RosterSettings({
  harnesses,
  onOpen,
}: {
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Opens the harnesses page, while none can run. */
  onOpen?: () => void;
}) {
  const models = useModels();
  const driven = useAtomValue(machineAtom);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const drivenVersion =
    driven === undefined || account?._tag !== "SignedIn"
      ? undefined
      : (account.devices.find((device) => device.id === driven.id)?.rpcVersion ?? 0);
  const rosterOk = drivenVersion === undefined || drivenVersion >= ROSTER_VERSION;

  return (
    <SettingsPage
      perMachine
      title="Roster"
      description="The models a lead starts without asking you, first choice first. It asks before starting any other."
    >
      {rosterOk ? (
        <RosterSection
          models={models}
          harnesses={harnesses}
          empty={
            <SettingsNote>
              No harness can run yet.{" "}
              {onOpen ? (
                <button
                  type="button"
                  onClick={onOpen}
                  className="text-fg-secondary underline-offset-2 hover:underline"
                >
                  Set one up
                </button>
              ) : null}
            </SettingsNote>
          }
        />
      ) : (
        <SettingsNote>Update Cerium on that computer to choose its roster.</SettingsNote>
      )}
    </SettingsPage>
  );
}

/** The experimental advisor agents can ask when they're stuck. */
export function AdvisorSettings({ harnesses }: { harnesses: ReadonlyArray<HarnessIndicator> }) {
  const { models, model } = useLeadModel(harnesses);
  return (
    <SettingsPage
      perMachine
      title={
        <>
          Advisor
          <SettingsTag>Experimental</SettingsTag>
        </>
      }
      description="A change applies to agents started after it."
    >
      <SettingsList>
        <AdvisorRows models={models} harnesses={harnesses} leadModel={model} />
      </SettingsList>
    </SettingsPage>
  );
}

/**
 * Every model the usable harnesses offer, under each harness's name. With none to offer yet, it says
 * why: the lists are still arriving, a harness listed none, or no harness can run.
 */
function ModelSelect({
  value,
  onChange,
  models,
  harnesses,
  onOpenHarnesses,
}: {
  value: ModelInfo | undefined;
  onChange: (model: string) => void;
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
  onOpenHarnesses?: () => void;
}) {
  const loading = useAtomValue(modelsAtom).waiting;
  const retry = useAtomRefresh(modelsAtom);
  const quiet =
    "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary";

  if (value !== undefined) {
    return (
      <SelectRoot value={modelKey(value)} onValueChange={(next) => next !== null && onChange(next)}>
        <SelectTrigger label="Model">
          <ProviderLogo provider={value.provider} size={13} />
          <span>{value.label}</span>
        </SelectTrigger>
        <SelectPopup>
          <ModelGroups models={models} harnesses={harnesses} />
        </SelectPopup>
      </SelectRoot>
    );
  }
  if (readyProviders(harnesses).size === 0) {
    return onOpenHarnesses ? (
      <Button onClick={onOpenHarnesses} className={quiet}>
        Set up a harness
        <ChevronRight size={13} strokeWidth={1.75} className="text-fg-tertiary" />
      </Button>
    ) : (
      <span className="shrink-0 pr-1 text-meta text-fg-tertiary">No harness can run</span>
    );
  }
  return loading ? (
    <span className="shrink-0 pr-1 text-meta text-fg-tertiary">Loading models…</span>
  ) : (
    <Button onClick={retry} className={quiet}>
      <RefreshCw size={12} strokeWidth={1.75} />
      No models listed. Retry
    </Button>
  );
}
