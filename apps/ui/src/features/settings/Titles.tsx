import { OFFERED_PROVIDERS, TITLE_MODELS, type ModelInfo, type ProviderId } from "@cerium/protocol";

import { ModelPicker } from "../composer/ModelPicker.tsx";
import { modelKey } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { readyProviders } from "./ModelGroups.tsx";
import { SettingsRow, SettingsSwitch } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

/** The model Automatic names threads with here: the first default a usable harness offers. */
const automaticModel = (models: ReadonlyArray<ModelInfo>, ready: ReadonlySet<ProviderId>) =>
  TITLE_MODELS.flatMap((choice) =>
    ready.has(choice.provider)
      ? models.filter((model) => model.provider === choice.provider && model.id === choice.model)
      : [],
  )[0];

/**
 * Whether new threads are named from their first message, and by which model: rows for a card of
 * settings. Saved by the backend; Automatic follows Cerium's order of quick models.
 */
export function TitleRows({
  models,
  harnesses,
}: {
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
}) {
  const { value: titles, saved, save, error } = useSetting("titles", { enabled: true });

  const ready = readyProviders(harnesses);
  const automatic = automaticModel(models, ready);
  const picked = titles.model;
  const pickedInfo = picked
    ? models.find((model) => model.provider === picked.provider && model.id === picked.model)
    : undefined;
  const pickedReady = picked !== undefined && ready.has(picked.provider) && pickedInfo !== undefined;

  return (
    <>
      <SettingsRow
        label="Name new threads"
        hint="A quick model gives each a short title. A name you give it yourself stays."
        error={error}
        control={(labelledBy) => (
          <SettingsSwitch
            checked={titles.enabled}
            onCheckedChange={(on) => save({ ...titles, enabled: on })}
            disabled={saved === undefined}
            labelledBy={labelledBy}
          />
        )}
      />
      {titles.enabled ? (
        <SettingsRow
          label="Named by"
          hint={
            picked !== undefined && !pickedReady ? (
              <span className="text-attention-text">
                {providerName[picked.provider]} can't run right now, so threads keep their first line.
              </span>
            ) : undefined
          }
          className="pr-2.5"
          control={() => (
            <ModelPicker
              variant="select"
              side="bottom"
              align="end"
              ariaLabel="Model that names threads"
              models={models}
              providers={OFFERED_PROVIDERS}
              available={ready}
              shown={
                picked !== undefined
                  ? {
                      provider: picked.provider,
                      label: pickedInfo?.label ?? picked.model,
                      ...(pickedInfo ? { key: modelKey(pickedInfo) } : {}),
                    }
                  : undefined
              }
              automatic={{
                on: picked === undefined,
                model: automatic
                  ? { provider: automatic.provider, label: automatic.label, key: modelKey(automatic) }
                  : undefined,
                hint: automatic
                  ? `${automatic.label} now, the quickest your harnesses offer`
                  : "The quickest model your harnesses offer",
                onPick: () => save({ enabled: true }),
              }}
              onPick={(model) =>
                save({ enabled: true, model: { provider: model.provider, model: model.id } })
              }
            />
          )}
        />
      ) : null}
    </>
  );
}
