import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { AccessMode, AdvisorSettings, ModelInfo, ProviderId, ReasoningEffort } from "@cerium/protocol";
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  Bot,
  Check,
  Eye,
  FilePen,
  Minus,
  Plug,
  ShieldCheck,
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
import { SettingsCard, SettingsPage, SettingsSection, SettingsSwitch } from "./parts.tsx";
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

type Permission = "yes" | "reviewed" | "asks" | "no";
/** What each access mode lets an agent do, matching the descriptions the composer gives. */
const accessMatrix: Record<AccessMode, readonly [read: Permission, edit: Permission, run: Permission]> = {
  readOnly: ["yes", "no", "no"],
  ask: ["yes", "asks", "asks"],
  acceptEdits: ["yes", "yes", "asks"],
  auto: ["yes", "reviewed", "reviewed"],
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
    <SettingsPage
      perMachine
      title="Agents"
      description="How new threads start, and what their agents can reach."
    >
      <SettingsSection
        title="Lead model"
        description="The model that leads a new thread. The composer offers the same choice and remembers the last one picked."
      >
        <ModelPicker
          label="Lead model"
          value={model}
          onChange={setModelId}
          models={models}
          harnesses={harnesses}
        />
      </SettingsSection>

      {model && activeEffort ? (
        <SettingsSection
          title="Reasoning effort"
          description={`How long ${model.label} thinks before it answers.`}
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
        description="What the lead of every new work thread may do in its folder, Auto unless you change it here. A pick in the composer covers just the thread it starts. Chats are always read only, and agents a lead starts never get more than it has."
      >
        <AccessPicker value={access} onChange={setAccess} />
      </SettingsSection>

      <SettingsSection
        title="Advisor"
        description="A model your agents can ask when they're stuck. It reads what it needs and answers, but never edits, runs commands or starts agents. Your strongest model makes the best advisor."
      >
        <AdvisorSetting models={models} harnesses={harnesses} leadModel={model} />
      </SettingsSection>

      <SettingsSection title="Thread titles">
        <TitleSetting models={models} harnesses={harnesses} />
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
  label,
  value,
  onChange,
  models,
  harnesses,
}: {
  label: string;
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
                <span className="truncate text-xs text-fg-tertiary">{value.description}</span>
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

/** One row per access mode, with what it allows in a column per ability. */
function AccessPicker({ value, onChange }: { value: AccessMode; onChange: (access: AccessMode) => void }) {
  const columns = "grid grid-cols-[minmax(0,1.25fr)_repeat(3,minmax(0,1fr))] items-center gap-3";
  const selected = accessOptions.find((option) => option.value === value);
  return (
    <div className="rounded-xl border border-line-subtle">
      <div
        aria-hidden
        className={`${columns} border-b border-line-subtle py-2 pr-3.5 pl-3.5 text-2xs text-fg-tertiary`}
      >
        <span />
        {abilities.map((ability) => (
          <span key={ability}>{ability}</span>
        ))}
      </div>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as AccessMode)}
        aria-label="Access"
        className="divide-y divide-line-subtle"
      >
        {accessOptions.map((option) => {
          const Icon = accessIcon[option.value];
          return (
            <Radio.Root
              key={option.value}
              value={option.value}
              nativeButton
              render={<button type="button" aria-label={`${option.label}: ${option.description}`} />}
              className={`group ${columns} min-h-11 w-full py-2 pr-3.5 pl-3.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-inset`}
            >
              <span className="flex min-w-0 items-center gap-3 text-[13px] text-fg-secondary group-data-checked:text-fg-primary">
                <span className="grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong transition-colors group-hover:border-fg-tertiary group-data-checked:border-accent group-data-checked:bg-accent">
                  <Radio.Indicator className="size-1.5 rounded-full bg-accent-fg" />
                </span>
                <Icon size={14} strokeWidth={1.75} className="shrink-0" />
                <span className="truncate group-data-checked:font-medium">{option.label}</span>
              </span>
              {accessMatrix[option.value].map((permission, index) => (
                <PermissionCell key={abilities[index]} permission={permission} />
              ))}
            </Radio.Root>
          );
        })}
      </RadioGroup>
      {selected ? (
        <p className="border-t border-line-subtle px-3.5 py-3 text-[12.5px] text-fg-secondary">
          <span className="font-medium text-fg-primary">{selected.label}.</span> {selected.description}.
        </p>
      ) : null}
    </div>
  );
}

const permissionLabel: Record<Permission, string> = {
  yes: "Yes",
  reviewed: "Reviewed",
  asks: "Asks",
  no: "No",
};

function PermissionCell({ permission }: { permission: Permission }) {
  return (
    <span
      className={`flex items-center gap-1.5 text-xs ${
        permission === "asks"
          ? "text-attention"
          : permission === "no"
            ? "text-fg-disabled"
            : "text-fg-secondary"
      }`}
    >
      {permission === "yes" ? (
        <Check size={13} strokeWidth={2.25} className="text-fg-primary" />
      ) : permission === "reviewed" ? (
        <ShieldCheck size={13} strokeWidth={1.75} />
      ) : permission === "asks" ? (
        <span className="mx-[3.5px] size-1.5 rounded-full bg-attention" />
      ) : (
        <Minus size={13} strokeWidth={2} />
      )}
      {permission === "yes" ? null : permissionLabel[permission]}
    </span>
  );
}

/** An advisor is there to think hard, so a new pick starts at the model's strongest effort. */
const advisorEffort = (model: ModelInfo, wanted?: ReasoningEffort) =>
  wanted !== undefined && model.efforts.includes(wanted) ? wanted : model.efforts.at(-1);

const advisorPick = (model: ModelInfo, wanted?: ReasoningEffort) => {
  const effort = advisorEffort(model, wanted);
  return { provider: model.provider, model: model.id, ...(effort ? { effort } : {}) };
};

/**
 * Whether agents may ask an advisor, and the model and effort it answers with. Saved by the backend;
 * the pick is kept while it's off. Turning it on with no pick yet starts from the lead model.
 */
function AdvisorSetting({
  models,
  harnesses,
  leadModel,
}: {
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
  leadModel: ModelInfo | undefined;
}) {
  const result = useAtomValue(settingsAtom);
  const refresh = useAtomRefresh(settingsAtom);
  const update = useAtomSet(updateSettings, { mode: "promise" });
  /** The choice being saved, shown before the backend confirms it. */
  const [saving, setSaving] = useState<AdvisorSettings>();
  const [error, setError] = useState<string>();
  const labelId = useId();

  const saved = AsyncResult.isSuccess(result) ? result.value.advisor : undefined;
  const advisor = saving ?? saved ?? { enabled: false };
  const picked = advisor.model;
  const model = picked
    ? models.find((candidate) => candidate.provider === picked.provider && candidate.id === picked.model)
    : undefined;
  const effort = model ? advisorEffort(model, picked?.effort) : undefined;

  const save = (next: AdvisorSettings) => {
    setSaving(next);
    setError(undefined);
    update({ payload: { advisor: next } }).then(
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
  const toggle = (on: boolean) => {
    const start = on && picked === undefined && leadModel ? { model: advisorPick(leadModel) } : {};
    save({ ...advisor, ...start, enabled: on });
  };
  const chooseModel = (key: string) => {
    const next = models.find((candidate) => modelKey(candidate) === key);
    if (next) save({ enabled: true, model: advisorPick(next, picked?.effort) });
  };

  return (
    <>
      <SettingsCard className="flex items-start gap-4 p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={labelId} className="text-[13px] font-medium text-fg-primary">
            Let agents ask an advisor
          </span>
          <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
            Agents get <code className="font-mono text-[11.5px] text-fg-secondary">ask_advisor</code> to put a
            question to it. Each thread starts its own advisor with the first question, so it remembers what
            that thread asked. Agents started after you turn it on are told it's there.
          </p>
          {error ? <p className="text-[12.5px] text-error">{error}</p> : null}
        </div>
        <SettingsSwitch
          checked={advisor.enabled}
          onCheckedChange={toggle}
          disabled={saved === undefined}
          labelledBy={labelId}
        />
      </SettingsCard>
      {advisor.enabled ? (
        <>
          <AdvisorPart title="Answers with">
            <ModelPicker
              label="Advisor model"
              value={model}
              onChange={chooseModel}
              models={models}
              harnesses={harnesses}
            />
          </AdvisorPart>
          {model && effort && picked ? (
            <AdvisorPart title={`How long ${model.label} thinks`}>
              <EffortGauge
                label="Advisor reasoning effort"
                levels={model.efforts}
                value={effort}
                onChange={(next) => save({ enabled: true, model: { ...picked, effort: next } })}
              />
            </AdvisorPart>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** One of the advisor's choices under a caption, set apart from the lead's identical controls above. */
function AdvisorPart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      <span className="text-xs font-medium text-fg-secondary">{title}</span>
      {children}
    </div>
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
        <SettingsSwitch
          checked={on}
          onCheckedChange={change}
          disabled={saved === undefined}
          labelledBy={labelId}
        />
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
        <Node
          icon={<CeriumMark size={14} />}
          title="Cerium"
          detail="Coordinate agents, drive UIs, run live checks"
        />
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
