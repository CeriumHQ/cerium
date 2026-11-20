import type { ProviderId } from "@cerium/protocol";

import { ProviderLogo } from "./ProviderLogo.tsx";

const tile = {
  sm: "size-5 rounded-[5px]",
  md: "size-7 rounded-md",
} as const;

/** A harness's mark in a tile, as Settings draws each harness: who is doing the work, wherever an agent is named. */
export function ProviderMark({
  provider,
  size = "md",
  className,
}: {
  readonly provider: ProviderId;
  readonly size?: keyof typeof tile;
  readonly className?: string;
}) {
  return (
    <span
      className={`grid shrink-0 place-items-center border border-line-subtle bg-surface-raised text-fg-primary ${tile[size]} ${className ?? ""}`}
    >
      <ProviderLogo provider={provider} size={size === "sm" ? 11 : 15} />
    </span>
  );
}
