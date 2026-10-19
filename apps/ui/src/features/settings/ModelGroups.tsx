import type { ModelInfo, ProviderId } from "@cerium/protocol";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator } from "../../components/ui/Select.tsx";
import { modelKey } from "../composer/models.ts";
import { providerName } from "../threads/model.ts";
import type { HarnessIndicator } from "../threads/Sidebar.tsx";

/** The providers whose harness can run right now. */
export const readyProviders = (harnesses: ReadonlyArray<HarnessIndicator>): ReadonlySet<ProviderId> =>
  new Set(harnesses.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])));

/**
 * The menu items for a pick among models that aren't the lead's: every model a usable harness
 * offers, under the harness's name. Goes inside a `SelectPopup`; the caller's own items, such as
 * "Automatic", come first.
 */
export function ModelGroups({
  models,
  harnesses,
  separated = false,
}: {
  models: ReadonlyArray<ModelInfo>;
  harnesses: ReadonlyArray<HarnessIndicator>;
  /** A separator before the first group, for items of the caller's above it. */
  separated?: boolean;
}) {
  const ready = readyProviders(harnesses);
  const groups = harnesses.flatMap(({ provider }) => {
    const choices = ready.has(provider) ? models.filter((model) => model.provider === provider) : [];
    return choices.length === 0 ? [] : [{ provider, choices }];
  });
  return groups.map(({ provider, choices }, index) => (
    <SelectGroup key={provider}>
      {separated || index > 0 ? <SelectSeparator /> : null}
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
  ));
}
