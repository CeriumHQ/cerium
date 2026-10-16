import type { ProviderId } from "@cerium/protocol";

const providerColor: Record<ProviderId, string> = {
  claude: "bg-provider-claude",
  codex: "bg-provider-codex",
  muse: "bg-provider-muse",
  cursor: "bg-provider-cursor",
};

/** A small identity marker for a harness. */
export function ProviderDot({ provider, className }: { provider: ProviderId; className?: string }) {
  return (
    <span className={`inline-block size-1.5 rounded-full ${providerColor[provider]} ${className ?? ""}`} />
  );
}
