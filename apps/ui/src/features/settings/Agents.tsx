import { Button } from "@base-ui/react/button";
import type { AccessMode, ModelInfo, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronRight,
  Eye,
  FilePen,
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
import { EffortRouterSetting } from "./EffortRouter.tsx";
import { ModelGroups, readyProviders } from "./ModelGroups.tsx";
import { SettingsList, SettingsPage, SettingsRow, SettingsSection } from "./parts.tsx";
import { accessAtom, effortAtom, modelAtom } from "./preferences.ts";
import { RosterSection } from "./Roster.tsx";
import { TitleRows } from "./Titles.tsx";
import { AdvisorRows, McpServersRow } from "./Tools.tsx";

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

/**
 * How agents work: what every new thread starts with (each changed for one thread in its composer),
 * the tools they're given, and the effort router.
 */
export function AgentSettings({
  harnesses,
  onOpenHarnesses,
}: {
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Opens the harnesses page, while none can run. */
  onOpenHarnesses?: () => void;
}) {
  const [modelId, setModelId] = useAtom(modelAtom);
  const [effort, setEffort] = useAtom(effortAtom);
  const [access, setAccess] = useAtom(accessAtom);
  const models = useModels();
  const model = pickModel(models, modelId, readyProviders(harnesses));
  // Like the composer, a level the model lacks reads as its default or strongest one.
  const activeEffort = model ? effortFor(model, effort) : undefined;
  const accessOption = accessOptions.find((option) => option.value === access);
  const driven = useAtomValue(machineAtom);
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom), () => undefined);
  const drivenVersion =
    driven === undefined || account?._tag !== "SignedIn"
      ? undefined
      : (account.devices.find((device) => device.id === driven.id)?.rpcVersion ?? 0);
  const rosterOk = drivenVersion === undefined || drivenVersion >= ROSTER_VERSION;

  return (
    <SettingsPage perMachine title="Agents">
      <SettingsSection title="New threads" description="The message box changes these for one thread.">
        <SettingsList>
          <SettingsRow
            label="Model"
            hint={model?.description}
            className="pr-2.5"
            control={() => (
              <ModelSelect
                value={model}
                onChange={setModelId}
                models={models}
                harnesses={harnesses}
                {...(onOpenHarnesses ? { onOpenHarnesses } : {})}
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
                    <span className="font-medium text-fg-primary">{effortLabel[activeEffort]}</span>
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
          <SettingsRow
            label="Access"
            hint={`${accessOption?.description ?? ""}. Chats are always read only.`}
            className="pr-2.5"
            control={() => (
              <SelectRoot value={access} onValueChange={(next) => next !== null && setAccess(next)}>
                <SelectTrigger label="Access">
                  <span className="font-medium text-fg-primary">{accessOption?.label}</span>
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
          <TitleRows models={models} harnesses={harnesses} />
        </SettingsList>
      </SettingsSection>

      {rosterOk ? <RosterSection models={models} harnesses={harnesses} /> : null}

      <SettingsSection title="Tools" description="A change applies to agents started after it.">
        <SettingsList>
          <AdvisorRows models={models} harnesses={harnesses} leadModel={model} />
          <McpServersRow />
        </SettingsList>
      </SettingsSection>

      <EffortRouterSetting />
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
          <span className="font-medium text-fg-primary">{value.label}</span>
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
