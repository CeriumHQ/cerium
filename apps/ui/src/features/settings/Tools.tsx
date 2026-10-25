import type { AdvisorSettings, ModelInfo, ReasoningEffort } from "@cerium/protocol";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { effortLabel, modelKey } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { ModelGroups, readyProviders } from "./ModelGroups.tsx";
import { SettingsRow, SettingsSwitch } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

// What agents can call on beyond their own harness: the advisor, and the MCP servers they're given.
// Rows for the Agents page's Tools card.

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
export function AdvisorRows({
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
    <>
      <SettingsRow
        label="Advisor"
        hint="A model agents can ask when they're stuck. It reads and answers, but never edits or runs anything."
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
          label="Advisor model"
          hint={
            idle && picked ? (
              <span className="text-attention">{providerName[picked.provider]} can't run right now.</span>
            ) : undefined
          }
          className="pr-2.5"
          control={() => (
            <span className="flex shrink-0 items-center">
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
              {model && picked && effort ? (
                <SelectRoot
                  value={effort}
                  onValueChange={(next) =>
                    next !== null && save({ enabled: true, model: { ...picked, effort: next } })
                  }
                >
                  <SelectTrigger label="Advisor reasoning effort">{effortLabel[effort]}</SelectTrigger>
                  <SelectPopup>
                    {model.efforts.map((level) => (
                      <SelectItem key={level} value={level}>
                        {effortLabel[level]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </SelectRoot>
              ) : null}
            </span>
          )}
        />
      ) : null}
    </>
  );
}

/** Whether agents get the user's own MCP servers as well as Cerium's, which they always have. */
export function McpServersRow() {
  const { value: on, saved, save, error } = useSetting("includeUserMcpServers", true);
  return (
    <SettingsRow
      label="Your MCP servers"
      hint={
        <>
          The ones set up in each harness, like a project's{" "}
          <code className="font-mono text-caption text-fg-secondary">.mcp.json</code>. Cerium's own tools are
          always on.
        </>
      }
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
  );
}
