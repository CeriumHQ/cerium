import type { Updates } from "../../backend/shell.ts";
import { BUILD_VERSION } from "../../backend/target.ts";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useUpdates } from "./useUpdates.ts";

/** Nightlies carry `-nightly.n<run>` in their version (scripts/release.ts). */
export const isNightlyVersion = (version: string): boolean => version.includes("-nightly.");

/**
 * The running build's version when it's a nightly, else undefined. The desktop's updater knows the
 * shell's own build; the web client, and the desktop before its updater answers, go by the version the
 * UI was built with (`dev` in development, which is never a nightly).
 */
export function nightlyVersion(
  updates: Pick<Updates, "buildChannel" | "version"> | undefined,
  buildVersion: string,
): string | undefined {
  if (updates !== undefined) return updates.buildChannel === "nightly" ? updates.version : undefined;
  return isNightlyVersion(buildVersion) ? buildVersion : undefined;
}

/** What the tag's tooltip says: `Cerium Nightly · v0.18.0-nightly.n000292`. */
export const nightlyLabel = (version: string): string => `Cerium Nightly · v${version.replace(/^v/, "")}`;

/**
 * A nightly edition mark raised beside the brand in the desktop titlebar. The mark sits
 * outside the window's drag region so hovering can show the exact build.
 */
export function NightlyTag() {
  const version = nightlyVersion(useUpdates(), BUILD_VERSION);
  if (version === undefined) return null;
  return (
    <Tooltip label={nightlyLabel(version)}>
      <span
        data-nightly=""
        className="shrink-0 text-[9px] leading-none font-semibold tracking-[0.12em] text-fg-tertiary uppercase select-none transition-colors hover:text-fg-secondary [app-region:no-drag] -translate-y-1"
      >
        NIGHTLY
      </span>
    </Tooltip>
  );
}
