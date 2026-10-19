import { Button } from "@base-ui/react/button";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { AccessMode, ModelInfo, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
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

import { modelsAtom } from "../../backend/atoms.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import {
  accessOptions,
  defaultModel,
  effortFor,
  effortLabel,
  modelKey,
  pickModel,
  useModels,
} from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { readyProviders } from "./ModelGroups.tsx";
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";
import { TitleSetting } from "./Titles.tsx";
import { accessAtom, effortAtom, modelAtom } from "./preferences.ts";

const unavailableReason: Record<Exclude<HarnessIndicator["state"], "ready">, string> = {
  loggedOut: "Not logged in",
  missing: "Not installed",
  unsupported: "Not supported yet",
};

const effortHint: Record<ReasoningEffort, string> = {
  minimal: "Answers almost at once, with barely any reasoning.",
  low: "Quick answers for simple, well-defined tasks.",
  medium: "A balance of speed and depth.",
  high: "Thinks problems through before acting.",
  xhigh: "Takes its time on hard problems.",
  max: "Reasons as long as the model allows: the slowest and the most expensive.",
};

const accessIcon: Record<AccessMode, LucideIcon> = {
  readOnly: Eye,
  ask: ShieldQuestion,
  acceptEdits: FilePen,
  auto: ShieldCheck,
  fullAccess: ShieldOff,
};

/** The defaults a new thread starts with. Each is changed for one thread in its composer. */
export function AgentSettings({
  harnesses,
  onOpenHarnesses,
}: {
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** Opens the harnesses page, for one that can't run yet. */
  onOpenHarnesses?: () => void;
}) {
  const [modelId, setModelId] = useAtom(modelAtom);
  const [effort, setEffort] = useAtom(effortAtom);
  const [access, setAccess] = useAtom(accessAtom);
  const models = useModels();
  const model = pickModel(models, modelId, readyProviders(harnesses));
  // Like the composer, a level the model lacks reads as its default or strongest one.
  const activeEffort = model ? effortFor(model, effort) : undefined;

  return (
    <SettingsPage perMachine title="Agents" description="What every new thread starts with.">
      <SettingsSection
        title="Lead model"
        info="The model that leads a new thread. The composer offers the same choice and remembers the last one picked."
      >
        <ModelPicker
          label="Lead model"
          value={model}
          onChange={setModelId}
          models={models}
          harnesses={harnesses}
          {...(onOpenHarnesses ? { onOpenHarnesses } : {})}
        />
      </SettingsSection>

      {model && activeEffort ? (
        <SettingsSection
          title="Reasoning effort"
          info={`How long ${model.label} thinks before it answers. Each model has its own levels.`}
          action={<span className="pb-px text-xs text-fg-tertiary">{model.label}</span>}
        >
          <EffortGauge
            label="Reasoning effort"
            levels={model.efforts}
            value={activeEffort}
            onChange={setEffort}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Access"
        info="What the lead of every new work thread may do in its folder. A pick in the composer covers just the thread it starts. Chats are always read only, and agents a lead starts never get more than it has."
      >
        <AccessPicker value={access} onChange={setAccess} />
      </SettingsSection>

      <TitleSetting models={models} harnesses={harnesses} />
    </SettingsPage>
  );
}

/**
 * One row per harness: the radio picks the provider, the menu picks among its models. Harnesses offer
 * many models, so only the chosen one shows. A harness that can't run says why and points to where it's
 * fixed.
 */
function ModelPicker({
  label,
  value,
  onChange,
  models,
  harnesses,
  onOpenHarnesses,
}: {
  label: string;
  value: ModelInfo | undefined;
  onChange: (model: string) => void;
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
  onOpenHarnesses?: () => void;
}) {
  // The lists arrive harness by harness; a ready harness with none yet is still answering, until it isn't.
  const loading = useAtomValue(modelsAtom).waiting;
  const retry = useAtomRefresh(modelsAtom);
  const choose = (provider: ProviderId) => {
    const model = defaultModel(models, provider);
    if (model !== undefined) onChange(modelKey(model));
  };
  return (
    <RadioGroup
      value={value?.provider ?? null}
      onValueChange={(next) => choose(next as ProviderId)}
      aria-label={label}
      className="divide-y divide-line-subtle rounded-xl border border-line-subtle"
    >
      {harnesses.map(({ provider, state }) => {
        const offered = models.filter((model) => model.provider === provider);
        const ready = state === "ready" && offered.length > 0;
        const shown = value?.provider === provider ? value : defaultModel(models, provider);
        return (
          <div key={provider} className="flex min-h-12 items-center gap-3 py-2 pr-2.5 pl-3.5">
            <Radio.Root
              value={provider}
              disabled={!ready}
              nativeButton
              render={<button type="button" aria-label={providerName[provider]} />}
              className="group flex min-w-0 flex-1 items-center gap-3 self-stretch rounded-md text-left text-[13px] text-fg-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:text-fg-primary data-disabled:text-fg-tertiary"
            >
              <span className="grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors group-hover:border-fg-tertiary group-data-checked:border-accent group-data-checked:bg-accent group-data-disabled:border-line-subtle">
                <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
              </span>
              <ProviderLogo
                provider={provider}
                size={14}
                {...(ready ? {} : { className: "opacity-35 grayscale" })}
              />
              <span className="group-data-checked:font-medium">{providerName[provider]}</span>
              {value?.provider === provider && value.description ? (
                <span className="truncate text-xs text-fg-tertiary max-md:hidden">{value.description}</span>
              ) : null}
            </Radio.Root>
            {ready && shown ? (
              <SelectRoot value={modelKey(shown)} onValueChange={(next) => next !== null && onChange(next)}>
                <SelectTrigger label={`${providerName[provider]} ${label.toLowerCase()}`}>
                  <span className={value?.provider === provider ? "font-medium text-fg-primary" : ""}>
                    {shown.label}
                  </span>
                </SelectTrigger>
                <SelectPopup>
                  {offered.map((model) => (
                    <SelectItem key={model.id} value={modelKey(model)}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </SelectRoot>
            ) : state === "ready" ? (
              loading ? (
                <span className="shrink-0 pr-1 text-xs text-fg-tertiary">Loading models…</span>
              ) : (
                <span className="flex shrink-0 items-center gap-1 text-xs text-fg-tertiary">
                  No models listed
                  <Button
                    onClick={retry}
                    className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
                  >
                    <RefreshCw size={12} strokeWidth={1.75} />
                    Retry
                  </Button>
                </span>
              )
            ) : state !== "unsupported" && onOpenHarnesses ? (
              <Button
                onClick={onOpenHarnesses}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md pr-1.5 pl-2 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
              >
                {unavailableReason[state]}
                <ChevronRight size={13} strokeWidth={1.75} className="text-fg-tertiary" />
              </Button>
            ) : (
              <span className="shrink-0 pr-1 text-xs text-fg-tertiary">{unavailableReason[state]}</span>
            )}
          </div>
        );
      })}
    </RadioGroup>
  );
}

/** The model's effort levels as rising bars, filled up to the chosen one. */
function EffortGauge({
  label,
  levels,
  value,
  onChange,
}: {
  label: string;
  levels: ReadonlyArray<ReasoningEffort>;
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
}) {
  const chosen = levels.indexOf(value);
  return (
    <SettingsCard className="flex flex-col gap-3 px-4 pt-4 pb-3.5">
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as ReasoningEffort)}
        aria-label={label}
        className="flex items-end gap-1"
      >
        {levels.map((level, index) => (
          <Radio.Root
            key={level}
            value={level}
            nativeButton
            render={<button type="button" aria-label={effortLabel[level]} />}
            className="group flex flex-1 flex-col items-stretch gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-4 focus-visible:ring-offset-surface-panel"
          >
            <span className="flex h-11 items-end">
              {/* Levels above the chosen one are still bars, dimmed: a gauge with room left, not missing parts. */}
              <span
                className={`w-full rounded-[4px] transition-[background-color,height] duration-300 ease-out-soft ${
                  index <= chosen ? "bg-fg-primary" : "bg-line-strong group-hover:bg-fg-disabled"
                }`}
                style={{
                  height: `${16 + (84 * index) / Math.max(1, levels.length - 1)}%`,
                  // Filled bars brighten towards the chosen level.
                  ...(index <= chosen ? { opacity: 0.45 + (0.55 * (index + 1)) / (chosen + 1) } : {}),
                }}
              />
            </span>
            <span
              className={`text-center text-xs transition-colors ${
                index === chosen
                  ? "font-medium text-fg-primary"
                  : "text-fg-tertiary group-hover:text-fg-secondary"
              }`}
            >
              {effortLabel[level]}
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
      <p className="border-t border-line-subtle pt-3 text-[12.5px] text-fg-secondary">
        <span className="font-medium text-fg-primary">{effortLabel[value]}.</span> {effortHint[value]}
      </p>
    </SettingsCard>
  );
}

/** One row per access mode, each saying what it allows. */
function AccessPicker({ value, onChange }: { value: AccessMode; onChange: (access: AccessMode) => void }) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as AccessMode)}
      aria-label="Access"
      className="rounded-xl border border-line-subtle"
    >
      {accessOptions.map((option) => {
        const Icon = accessIcon[option.value];
        return (
          <Radio.Root
            key={option.value}
            value={option.value}
            nativeButton
            render={<button type="button" aria-label={`${option.label}: ${option.description}`} />}
            // Each radio is followed by its hidden input, so the rows are told apart by type, not position.
            className="group flex min-h-12 w-full items-center gap-3 border-line-subtle px-3.5 py-2 text-left outline-none first-of-type:rounded-t-xl last-of-type:rounded-b-xl not-first-of-type:border-t hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset"
          >
            <span className="grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors group-hover:border-fg-tertiary group-data-checked:border-accent group-data-checked:bg-accent">
              <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
            </span>
            <Icon
              size={14}
              strokeWidth={1.75}
              className="shrink-0 text-fg-secondary group-data-checked:text-fg-primary"
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] text-fg-secondary group-data-checked:font-medium group-data-checked:text-fg-primary">
                {option.label}
              </span>
              <span className="text-xs leading-snug text-fg-tertiary">{option.description}</span>
            </span>
          </Radio.Root>
        );
      })}
    </RadioGroup>
  );
}
