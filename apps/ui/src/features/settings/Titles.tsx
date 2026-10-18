import { TITLE_MODELS, type ModelInfo, type ProviderId, type TitleSettings } from "@cerium/protocol";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowRight, Sparkles } from "lucide-react";
import { useId, useState } from "react";

import { settingsAtom, updateSettings } from "../../backend/atoms.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import {
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
} from "../../components/ui/Select.tsx";
import { modelKey } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";
import { SettingsCard, SettingsSwitch } from "./parts.tsx";

const AUTOMATIC = "automatic";

/** The model Automatic names threads with here: the first default a usable harness offers. */
const automaticModel = (models: ReadonlyArray<ModelInfo>, ready: ReadonlySet<ProviderId>) =>
  TITLE_MODELS.flatMap((choice) =>
    ready.has(choice.provider)
      ? models.filter((model) => model.provider === choice.provider && model.id === choice.model)
      : [],
  )[0];

/**
 * Whether new threads are named from their first message, and by which model. Saved by the backend;
 * Automatic follows Cerium's order of quick models.
 */
export function TitleSetting({
  models,
  harnesses,
}: {
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
}) {
  const result = useAtomValue(settingsAtom);
  const refresh = useAtomRefresh(settingsAtom);
  const update = useAtomSet(updateSettings, { mode: "promise" });
  /** The choice being saved, shown before the backend confirms it. */
  const [saving, setSaving] = useState<TitleSettings>();
  const [error, setError] = useState<string>();
  const labelId = useId();

  const saved = AsyncResult.isSuccess(result) ? result.value.titles : undefined;
  const titles = saving ?? saved ?? { enabled: true };
  const ready = new Set(harnesses.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])));
  const offered = models.filter((model) => ready.has(model.provider));
  const automatic = automaticModel(models, ready);
  const picked = titles.model;
  const pickedInfo = picked
    ? models.find((model) => model.provider === picked.provider && model.id === picked.model)
    : undefined;
  const pickedReady = picked !== undefined && ready.has(picked.provider) && pickedInfo !== undefined;

  const save = (next: TitleSettings) => {
    setSaving(next);
    setError(undefined);
    update({ payload: { titles: next } }).then(
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
  const choose = (key: string) => {
    const model = offered.find((candidate) => modelKey(candidate) === key);
    save(
      model === undefined
        ? { enabled: true }
        : { enabled: true, model: { provider: model.provider, model: model.id } },
    );
  };

  return (
    <SettingsCard className="flex flex-col">
      <div className="flex items-start gap-4 p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={labelId} className="text-[13px] font-medium text-fg-primary">
            Name new threads
          </span>
          <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
            A thread starts out named after the first line of your message. A quick model then gives it a
            short title while the agent works. A name you give it yourself always stays.
          </p>
          {error ? <p className="text-[12.5px] text-error">{error}</p> : null}
        </div>
        <SettingsSwitch
          checked={titles.enabled}
          onCheckedChange={(on) => save({ ...titles, enabled: on })}
          disabled={saved === undefined}
          labelledBy={labelId}
        />
      </div>

      {titles.enabled ? (
        <div className="flex min-h-12 items-center gap-3 border-t border-line-subtle py-2 pr-2.5 pl-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] text-fg-secondary">Named by</span>
            {picked !== undefined && !pickedReady ? (
              <span className="text-xs text-attention">
                {providerName[picked.provider]} can't run right now, so threads keep their first line.
              </span>
            ) : null}
          </div>
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
                  <span className="font-medium text-fg-primary">Automatic</span>
                  {automatic ? <span className="text-fg-tertiary">{automatic.label}</span> : null}
                </>
              ) : (
                <>
                  <ProviderLogo provider={picked.provider} size={13} />
                  <span className="font-medium text-fg-primary">{pickedInfo?.label ?? picked.model}</span>
                </>
              )}
            </SelectTrigger>
            <SelectPopup>
              <SelectItem
                value={AUTOMATIC}
                icon={Sparkles}
                description={
                  automatic
                    ? `${automatic.label} now, the quickest your harnesses offer`
                    : "The quickest model your harnesses offer"
                }
              >
                Automatic
              </SelectItem>
              {harnesses.map(({ provider }) => {
                const choices = offered.filter((model) => model.provider === provider);
                if (choices.length === 0) return null;
                return (
                  <SelectGroup key={provider}>
                    <SelectSeparator />
                    <SelectGroupLabel>
                      <ProviderLogo provider={provider} size={11} />
                      {providerName[provider]}
                    </SelectGroupLabel>
                    {choices.map((model) => (
                      <SelectItem key={model.id} value={modelKey(model)}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                );
              })}
            </SelectPopup>
          </SelectRoot>
        </div>
      ) : null}

      <TitleExample named={titles.enabled} />
    </SettingsCard>
  );
}

/** A thread's name as it starts and as the model leaves it; the second goes faint while titles are off. */
function TitleExample({ named }: { named: boolean }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 border-t border-line-subtle px-4 py-4">
      <ExampleRow text="can you help me figure out why my vite dev server keeps reloading every…" />
      <ArrowRight
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 transition-colors duration-300 ${named ? "text-fg-tertiary" : "text-line-strong"}`}
      />
      <ExampleRow text="Vite dev server keeps reloading" strong faint={!named} />
    </div>
  );
}

function ExampleRow({
  text,
  strong = false,
  faint = false,
}: {
  text: string;
  strong?: boolean;
  faint?: boolean;
}) {
  return (
    <div
      className={`flex h-8 min-w-0 flex-1 items-center rounded-lg border border-line-subtle bg-surface-raised px-2.5 transition-opacity duration-300 ${
        faint ? "opacity-40" : ""
      }`}
    >
      <span
        className={`truncate text-[12.5px] ${strong ? "font-medium text-fg-primary" : "text-fg-secondary"}`}
      >
        {text}
      </span>
    </div>
  );
}
