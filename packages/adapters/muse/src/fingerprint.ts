import { compareVersions } from "@cerium/harness";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import { SDK_RELEASE } from "./manifest.ts";

export type FingerprintVerdict = "exact" | "additive" | "incompatible";

/**
 * Compares the host's stable MSP schema with the one the SDK was built for. The SDK documents stable
 * evolution as additive, so a newer host is accepted; a host at or below the SDK's release that serves a
 * different schema is one the SDK cannot rely on.
 */
export const fingerprintVerdict = (
  served: string,
  hostVersion: string,
  pinned: string = EXPECTED_SCHEMA_FINGERPRINT,
): FingerprintVerdict => {
  if (served === pinned) return "exact";
  return compareVersions(hostVersion, SDK_RELEASE) > 0 ? "additive" : "incompatible";
};
