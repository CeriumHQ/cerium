import {
  OFFERED_PROVIDERS,
  type AdvisorSettings,
  type ModelInfo,
  type ReasoningEffort,
} from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";

import { modelsAtom } from "../../backend/atoms.ts";
import { ModelPicker } from "../composer/ModelPicker.tsx";
import { modelKey } from "../composer/models.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { advisorModelHint } from "./advisorModel.ts";
import { readyProviders } from "./ModelGroups.tsx";
import { SettingsRow, SettingsSwitch } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

// The advisor agents can call on beyond their own harness: the rows of the Advisor page.

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
  const ready = readyProviders(harnesses);
  const idle = picked !== undefined && !ready.has(picked.provider);
  const loading = useAtomValue(modelsAtom).waiting;
  const modelHint = advisorModelHint({ picked, listed: model !== undefined, idle, loading });

  const toggle = (on: boolean) => {
    const start: Partial<AdvisorSettings> =
      on && picked === undefined && leadModel ? { model: advisorPick(leadModel) } : {};
    save({ ...advisor, ...start, enabled: on });
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
          hint={modelHint ? <span className="text-attention-text">{modelHint}</span> : undefined}
          className="pr-2.5"
          control={() => (
            <ModelPicker
              variant="select"
              side="bottom"
              align="end"
              ariaLabel="Advisor model"
              placeholder="Choose"
              models={models}
              providers={OFFERED_PROVIDERS}
              available={ready}
              shown={
                picked
                  ? {
                      provider: picked.provider,
                      label: model?.label ?? picked.model,
                      ...(model ? { key: modelKey(model) } : {}),
                    }
                  : undefined
              }
              effort={{
                levels: model?.efforts ?? [],
                value: effort ?? "high",
                onPick: (next) => picked && save({ enabled: true, model: { ...picked, effort: next } }),
              }}
              effortShown={effort}
              onPick={(next) => save({ enabled: true, model: advisorPick(next, picked?.effort) })}
            />
          )}
        />
      ) : null}
    </>
  );
}
