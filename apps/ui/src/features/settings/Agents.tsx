import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
import type { AccessMode, ModelInfo, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Bot,
  Check,
  Eye,
  FilePen,
  Minus,
  Plug,
  ShieldOff,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { settingsAtom, updateSettings } from "../../backend/atoms.ts";
import { CeriumMark } from "../../components/CeriumMark.tsx";
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
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";
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
  fullAccess: ShieldOff,
};

type Permission = "yes" | "asks" | "no";
/** What each access mode lets an agent do, matching the descriptions the composer gives. */
const accessMatrix: Record<AccessMode, readonly [read: Permission, edit: Permission, run: Permission]> = {
  readOnly: ["yes", "no", "no"],
  ask: ["yes", "asks", "asks"],
  acceptEdits: ["yes", "yes", "asks"],
  fullAccess: ["yes", "yes", "yes"],
};
const abilities = ["Read and search", "Edit files", "Run commands"] as const;

export function AgentSettings({ harnesses }: { harnesses: ReadonlyArray<HarnessIndicator> }) {
  const [modelId, setModelId] = useAtom(modelAtom);
  const [effort, setEffort] = useAtom(effortAtom);
  const [access, setAccess] = useAtom(accessAtom);
  const models = useModels();
  const available = new Set(
    harnesses.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])),
  );
  const model = pickModel(models, modelId, available);
  // Like the composer, a level the model lacks reads as its default or strongest one.
  const activeEffort = model ? effortFor(model, effort) : undefined;

  return (
    <SettingsPage title="Agents" description="How new threads start, and what their agents can reach.">
      <SettingsSection
        title="Lead model"
        description="The model that leads a new thread. The composer offers the same choice and remembers the last one picked."
      >
        <ModelPicker value={model} onChange={setModelId} models={models} harnesses={harnesses} />
      </SettingsSection>

      {model && activeEffort ? (
        <SettingsSection
          title="Reasoning effort"
          description={`How long ${model.label} thinks before it answers.`}
        >
          <EffortGauge levels={model.efforts} value={activeEffort} onChange={setEffort} />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Access"
        description="What the lead of a new work thread may do in its folder. Chats are always read only, and agents it starts never get more than it has."
      >
        <AccessPicker value={access} onChange={setAccess} />
      </SettingsSection>

      <SettingsSection title="Tools">
        <McpServersSetting />
      </SettingsSection>
    </SettingsPage>
  );
}

/**
 * One row per harness: the radio picks the provider, the menu picks among its models. Harnesses offer
 * many models, so only the chosen one shows.
 */
function ModelPicker({
  value,
  onChange,
  models,
  harnesses,
}: {
  value: ModelInfo | undefined;
  onChange: (model: string) => void;
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
}) {
  const choose = (provider: ProviderId) => {
    const model = defaultModel(models, provider);
    if (model !== undefined) onChange(modelKey(model));
  };
  return (
    <RadioGroup
      value={value?.provider ?? null}
      onValueChange={(next) => choose(next as ProviderId)}
      aria-label="Lead model"
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
                <span className="truncate text-xs text-fg-tertiary">{value.description}</span>
              ) : null}
            </Radio.Root>
            {ready && shown ? (
              <SelectRoot value={modelKey(shown)} onValueChange={(next) => next !== null && onChange(next)}>
                <SelectTrigger label={`${providerName[provider]} model`}>
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
            ) : (
              <span className="shrink-0 pr-1 text-xs text-fg-disabled">
                {state === "ready" ? "No models offered" : unavailableReason[state]}
              </span>
            )}
          </div>
        );
      })}
    </RadioGroup>
  );
}

/** The model's effort levels as rising bars, filled up to the chosen one. */
function EffortGauge({
  levels,
  value,
  onChange,
}: {
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
        aria-label="Reasoning effort"
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
              <span
                className={`w-full rounded-[4px] transition-[background-color,box-shadow,height] duration-300 ease-out-soft ${
                  index <= chosen
                    ? "bg-fg-primary"
                    : "ring-1 ring-line-strong ring-inset group-hover:ring-fg-tertiary"
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

function AccessPicker({ value, onChange }: { value: AccessMode; onChange: (access: AccessMode) => void }) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as AccessMode)}
      aria-label="Access"
      className="grid grid-cols-4 gap-3"
    >
      {accessOptions.map((option) => {
        const Icon = accessIcon[option.value];
        return (
          <Radio.Root
            key={option.value}
            value={option.value}
            nativeButton
            render={<button type="button" aria-label={option.label} />}
            className="group flex flex-col gap-3 rounded-xl border border-line-subtle p-3.5 text-left transition-[border-color,box-shadow] duration-150 outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-focus-ring data-checked:border-accent data-checked:ring-1 data-checked:ring-accent"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium text-fg-secondary group-data-checked:text-fg-primary">
              <Icon size={15} strokeWidth={1.75} />
              {option.label}
            </span>
            <span className="flex flex-col gap-1.5">
              {abilities.map((ability, index) => (
                <PermissionLine
                  key={ability}
                  ability={ability}
                  permission={accessMatrix[option.value][index]!}
                />
              ))}
            </span>
          </Radio.Root>
        );
      })}
    </RadioGroup>
  );
}

function PermissionLine({ ability, permission }: { ability: string; permission: Permission }) {
  return (
    <span
      className={`flex items-center gap-2 text-xs ${permission === "no" ? "text-fg-disabled" : "text-fg-secondary"}`}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">
        {permission === "yes" ? (
          <Check size={13} strokeWidth={2.25} className="text-fg-primary" />
        ) : permission === "asks" ? (
          <span className="size-1.5 rounded-full bg-attention" />
        ) : (
          <Minus size={13} strokeWidth={2} />
        )}
      </span>
      {ability}
      {permission === "asks" ? <span className="ml-auto text-2xs text-attention">Asks</span> : null}
    </span>
  );
}

/** Whether sessions also get the MCP servers the user set up in each harness. Saved by the backend. */
function McpServersSetting() {
  const result = useAtomValue(settingsAtom);
  const refresh = useAtomRefresh(settingsAtom);
  const update = useAtomSet(updateSettings, { mode: "promise" });
  /** The choice being saved, shown before the backend confirms it. */
  const [saving, setSaving] = useState<boolean>();
  const [error, setError] = useState<string>();
  const labelId = useId();

  const saved = AsyncResult.isSuccess(result) ? result.value.includeUserMcpServers : undefined;
  const on = saving ?? saved ?? true;
  const change = (next: boolean) => {
    setSaving(next);
    setError(undefined);
    update({ payload: { includeUserMcpServers: next } }).then(
      () => {
        refresh();
        setSaving(undefined);
      },
      () => {
        setSaving(undefined);
        setError("Couldn't save that. Is Cerium's backend running?");
      },
    );
  };

  return (
    <SettingsCard className="flex flex-col">
      <div className="flex items-start gap-4 p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={labelId} className="text-[13px] font-medium text-fg-primary">
            Your MCP servers
          </span>
          <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
            Also give agents the MCP servers you set up in each harness, like those in Claude Code's settings
            or a project's <code className="font-mono text-[11.5px] text-fg-secondary">.mcp.json</code>.
            Cerium's own tools are always there. Applies to agents started after you change it.
          </p>
          {error ? <p className="text-[12.5px] text-error">{error}</p> : null}
        </div>
        <Switch.Root
          checked={on}
          onCheckedChange={change}
          disabled={saved === undefined}
          aria-labelledby={labelId}
          className="relative mt-0.5 flex h-5 w-9 shrink-0 rounded-full bg-line-strong p-0.5 transition-colors duration-200 ease-out-soft outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-panel data-checked:bg-accent data-disabled:opacity-40"
        >
          <Switch.Thumb className="size-4 rounded-full bg-fg-primary shadow-raised transition-[translate,background-color] duration-200 ease-out-soft data-checked:translate-x-4 data-checked:bg-accent-fg" />
        </Switch.Root>
      </div>
      <ToolSources connected={on} />
    </SettingsCard>
  );
}

/**
 * Where an agent's tools come from: Cerium's bus always, the user's own servers while the setting
 * is on. Live links carry a slow flow of dashes; a cut one goes faint.
 */
function ToolSources({ connected }: { connected: boolean }) {
  return (
    <div aria-hidden="true" className="flex items-center border-t border-line-subtle px-6 py-5">
      <Node icon={<Bot size={15} strokeWidth={1.75} />} title="Agent" />
      {/* Two 52px nodes 12px apart: their centres sit at 26 and 90 of 116. */}
      <svg viewBox="0 0 120 116" className="h-[116px] min-w-16 flex-1" preserveAspectRatio="none">
        <Link d="M0 58 C 60 58, 60 26, 120 26" live />
        <Link d="M0 58 C 60 58, 60 90, 120 90" live={connected} />
      </svg>
      <div className="flex flex-col gap-3">
        <Node icon={<CeriumMark size={14} />} title="Cerium" detail="Spawn, message and coordinate agents" />
        <Node
          icon={<Plug size={15} strokeWidth={1.75} />}
          title="Your servers"
          detail={connected ? "From each harness's own settings" : "Left out"}
          faint={!connected}
        />
      </div>
    </div>
  );
}

function Link({ d, live }: { d: string; live: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      vectorEffect="non-scaling-stroke"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeDasharray={live ? "4 6" : "1 5"}
      className={`transition-[stroke] duration-300 ${
        live
          ? "animate-[flow_1.4s_linear_infinite] stroke-fg-tertiary motion-reduce:animate-none"
          : "stroke-line-strong"
      }`}
    />
  );
}

function Node({
  icon,
  title,
  detail,
  faint = false,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  faint?: boolean;
}) {
  return (
    <div
      className={`flex h-13 items-center gap-2.5 rounded-lg border border-line-subtle bg-surface-raised px-2.5 transition-opacity duration-300 ${
        faint ? "opacity-40" : ""
      }`}
    >
      <span className="grid size-6 place-items-center rounded-md border border-line-subtle text-fg-primary">
        {icon}
      </span>
      <span className="flex flex-col">
        <span className="text-[12.5px] font-medium text-fg-primary">{title}</span>
        {detail ? <span className="text-2xs text-fg-tertiary">{detail}</span> : null}
      </span>
    </div>
  );
}
