import { TITLE_MODELS, type ModelInfo, type ProviderId } from "@cerium/protocol";
import { Zap } from "lucide-react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SelectItem, SelectPopup, SelectRoot, SelectTrigger } from "../../components/ui/Select.tsx";
import { modelKey } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { ModelGroups, readyProviders } from "./ModelGroups.tsx";
import { SettingsRow, SettingsSwitch } from "./parts.tsx";
import { useSetting } from "./useSetting.ts";

const AUTOMATIC = "automatic";

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
  const offered = models.filter((model) => ready.has(model.provider));
  const automatic = automaticModel(models, ready);
  const picked = titles.model;
  const pickedInfo = picked
    ? models.find((model) => model.provider === picked.provider && model.id === picked.model)
    : undefined;
  const pickedReady = picked !== undefined && ready.has(picked.provider) && pickedInfo !== undefined;

  const choose = (key: string) => {
    const model = offered.find((candidate) => modelKey(candidate) === key);
    save(
      model === undefined
        ? { enabled: true }
        : { enabled: true, model: { provider: model.provider, model: model.id } },
    );
  };

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
            <SelectRoot
              value={
                picked === undefined ? AUTOMATIC : modelKey({ provider: picked.provider, id: picked.model })
              }
              onValueChange={(next) => next !== null && choose(next)}
            >
              <SelectTrigger label="Model that names threads">
                {picked === undefined ? (
                  <>
                    {automatic ? <ProviderLogo provider={automatic.provider} size={13} /> : null}
                    <span>Automatic</span>
                    {automatic ? <span className="text-fg-tertiary">{automatic.label}</span> : null}
                  </>
                ) : (
                  <>
                    <ProviderLogo provider={picked.provider} size={13} />
                    <span>{pickedInfo?.label ?? picked.model}</span>
                  </>
                )}
              </SelectTrigger>
              <SelectPopup>
                <SelectItem
                  value={AUTOMATIC}
                  icon={Zap}
                  description={
                    automatic
                      ? `${automatic.label} now, the quickest your harnesses offer`
                      : "The quickest model your harnesses offer"
                  }
                >
                  Automatic
                </SelectItem>
                <ModelGroups models={models} harnesses={harnesses} separated />
              </SelectPopup>
            </SelectRoot>
          )}
        />
      ) : null}
    </>
  );
}
