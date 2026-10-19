import type { AdvisorSettings, ModelInfo, ReasoningEffort } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { effortLabel, modelKey, pickModel, useModels } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { ModelGroups, readyProviders } from "./ModelGroups.tsx";
import { SettingsCard, SettingsPage, SettingsRow, SettingsSection, SettingsSwitch } from "./parts.tsx";
import { modelAtom } from "./preferences.ts";
import { useSetting } from "./useSetting.ts";

/** What agents can call on beyond their own harness: the advisor, and the MCP servers they're given. */
export function ToolSettings({ harnesses }: { harnesses: ReadonlyArray<HarnessIndicator> }) {
  const models = useModels();
  const leadKey = useAtomValue(modelAtom);
  const lead = pickModel(models, leadKey, readyProviders(harnesses));

  return (
    <SettingsPage perMachine title="Tools">
      <SettingsSection
        title="Advisor"
        info={
          <>
            A model your agents can ask when they're stuck. It reads what it needs and answers, but never
            edits, runs commands or starts agents. Each thread starts its own with the first question, so it
            remembers what that thread asked. Agents started after you turn it on are told it's there.
          </>
        }
      >
        <AdvisorSetting models={models} harnesses={harnesses} leadModel={lead} />
      </SettingsSection>

      <SettingsSection title="MCP servers" info={mcpInfo}>
        <McpServersSetting />
      </SettingsSection>
    </SettingsPage>
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
  const { value: advisor, saved, save, error } = useSetting("advisor", { enabled: false });
  const picked = advisor.model;
  const model = picked
    ? models.find((candidate) => candidate.provider === picked.provider && candidate.id === picked.model)
    : undefined;
  const effort = model ? advisorEffort(model, picked?.effort) : undefined;
  const idle = picked !== undefined && !readyProviders(harnesses).has(picked.provider);

  const toggle = (on: boolean) => {
    const start: Partial<AdvisorSettings> =
      on && picked === undefined && leadModel ? { model: advisorPick(leadModel) } : {};
    save({ ...advisor, ...start, enabled: on });
  };
  const chooseModel = (key: string) => {
    const next = models.find((candidate) => modelKey(candidate) === key);
    if (next) save({ enabled: true, model: advisorPick(next, picked?.effort) });
  };

  return (
    <SettingsCard className="flex flex-col divide-y divide-line-subtle">
      <SettingsRow
        label="Let agents ask an advisor"
        hint="A model they can put a question to when they're stuck"
        error={error}
        control={(labelledBy) => (
          <SettingsSwitch
            checked={advisor.enabled}
            onCheckedChange={toggle}
            disabled={saved === undefined}
            labelledBy={labelledBy}
          />
        )}
      />
      {advisor.enabled ? (
        <SettingsRow
          label="Answers with"
          hint={
            idle && picked ? (
              <span className="text-attention">{providerName[picked.provider]} can't run right now.</span>
            ) : (
              "Your strongest model makes the best advisor."
            )
          }
          className="pr-2.5"
          control={() => (
            <SelectRoot
              value={model ? modelKey(model) : null}
              onValueChange={(next) => next !== null && chooseModel(next)}
            >
              <SelectTrigger label="Advisor model">
                {picked ? <ProviderLogo provider={picked.provider} size={13} /> : null}
                <span className="font-medium text-fg-primary">
                  {model?.label ?? picked?.model ?? "Choose"}
                </span>
              </SelectTrigger>
              <SelectPopup>
                <ModelGroups models={models} harnesses={harnesses} />
              </SelectPopup>
            </SelectRoot>
          )}
        />
      ) : null}
      {advisor.enabled && model && picked && effort ? (
        <SettingsRow
          label="Reasoning effort"
          className="pr-2.5"
          control={() => (
            <SelectRoot
              value={effort}
              onValueChange={(next) =>
                next !== null && save({ enabled: true, model: { ...picked, effort: next } })
              }
            >
              <SelectTrigger label="Advisor reasoning effort">
                <span className="font-medium text-fg-primary">{effortLabel[effort]}</span>
              </SelectTrigger>
              <SelectPopup>
                {model.efforts.map((level) => (
                  <SelectItem key={level} value={level}>
                    {effortLabel[level]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </SelectRoot>
          )}
        />
      ) : null}
    </SettingsCard>
  );
}

const mcpInfo = (
  <>
    Agents always get Cerium's own tools. You can also give them the MCP servers you set up in each harness,
    like those in Claude Code's settings or a project's{" "}
    <code className="font-mono text-[11px] text-fg-primary">.mcp.json</code>. A change applies to agents
    started after it.
  </>
);

/** Where an agent's tools come from: Cerium's always, and the user's own servers while the setting is on. */
function McpServersSetting() {
  const { value: on, saved, save, error } = useSetting("includeUserMcpServers", true);
  return (
    <SettingsCard className="flex flex-col divide-y divide-line-subtle">
      <SettingsRow
        label="Cerium"
        hint="Coordinate agents, drive UIs, run live checks"
        control={() => <span className="shrink-0 text-xs text-fg-tertiary">Always on</span>}
      />
      <SettingsRow
        label="Your servers"
        hint={on ? "From each harness's own settings" : "Left out"}
        error={error}
        control={(labelledBy) => (
          <SettingsSwitch
            checked={on}
            onCheckedChange={save}
            disabled={saved === undefined}
            labelledBy={labelledBy}
          />
        )}
      />
    </SettingsCard>
  );
}
