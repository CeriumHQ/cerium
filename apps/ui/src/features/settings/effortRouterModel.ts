/** Where an OpenRouter account makes its keys. */
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

/**
 * What the switch's row says under it, if anything: how to turn the router on without a key, and that
 * a router left on without one (its key file gone) waits for one.
 */
export const routerHint = ({
  enabled,
  hasKey,
  local,
  machineName,
}: {
  readonly enabled: boolean;
  /** Absent while the status is still loading. */
  readonly hasKey: boolean | undefined;
  readonly local: boolean;
  readonly machineName: string | undefined;
}): { readonly text: string; readonly attention: boolean } | undefined => {
  if (hasKey !== false) return undefined;
  if (enabled)
    return {
      text: "Waiting for an OpenRouter key. Until then, agents run at the effort set for them.",
      attention: true,
    };
  return local
    ? { text: "Turns on when you save an OpenRouter key below.", attention: false }
    : { text: `Needs an OpenRouter key from ${machineName ?? "that computer"}.`, attention: false };
};
