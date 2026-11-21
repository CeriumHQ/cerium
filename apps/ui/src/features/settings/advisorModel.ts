import type { ProviderId } from "@cerium/protocol";

import { providerName } from "../threads/model.ts";

/**
 * What the model row says under it, if anything: that agents can't ask yet because no model is
 * chosen, its harness can't run, or the model is no longer listed. Agents are offered the advisor only
 * with a model picked.
 */
export const advisorModelHint = ({
  picked,
  listed,
  idle,
  loading,
}: {
  readonly picked: { readonly provider: ProviderId; readonly model: string } | undefined;
  /** The pick is among the models the harnesses list. */
  readonly listed: boolean;
  /** The pick's harness can't run right now. */
  readonly idle: boolean;
  /** The harnesses' model lists are still arriving. */
  readonly loading: boolean;
}): string | undefined => {
  if (picked === undefined) return "Choose a model so agents can ask it.";
  if (idle) return `${providerName[picked.provider]} can't run right now.`;
  if (!listed && !loading) return `${picked.model} isn't offered anymore. Choose another model.`;
  return undefined;
};
