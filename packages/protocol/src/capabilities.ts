import { Schema } from "effect";

import { ProviderId } from "./ids.ts";

export const ReasoningEffort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = typeof ReasoningEffort.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * What an adapter's harness can do. The UI and orchestrator branch on these flags instead of on
 * provider names.
 */
export const CapabilityManifest = Schema.Struct({
  provider: ProviderId,
  /**
   * What viewers before `RPC_VERSION` 20 read as the harness versions Cerium tested. Cerium no longer
   * judges versions, so a backend sends it for those viewers only.
   */
  harnessVersion: Schema.optionalKey(
    Schema.Struct({
      minimum: Schema.NonEmptyString,
      testedMaximum: Schema.NonEmptyString,
    }),
  ),
  /**
   * Where the harness's releases are published, so Cerium can tell when a newer one is out, and the
   * harness's own command that updates it. Absent for a harness that ships inside Cerium.
   */
  releases: Schema.optionalKey(
    Schema.Struct({
      /** The npm package whose `latest` tag is the newest release. */
      npmPackage: Schema.NonEmptyString,
      updateCommand: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  session: Schema.Struct({
    resume: Schema.Boolean,
    fork: Schema.Boolean,
  }),
  switching: Schema.Struct({
    model: Schema.Boolean,
    effort: Schema.Boolean,
    /**
     * Some of the harness's models keep the provider's prompt cache when effort changes mid-session;
     * `ModelInfo.cacheSafeEffort` says which.
     */
    cacheSafeEffort: Schema.Boolean,
  }),
  input: Schema.Struct({
    images: Schema.Boolean,
  }),
  permissions: Schema.Struct({
    /**
     * How approval requests reach Cerium. `none`: the harness cannot ask, so the adapter withholds the
     * tools that would need approval instead.
     */
    approvals: Schema.Literals(["callback", "protocol", "hookBridge", "none"]),
    readOnlyMode: Schema.Boolean,
  }),
  mcpInjection: Schema.Boolean,
  nativeSubagents: Schema.Literals(["disableable", "notDisableable"]),
  usageReporting: Schema.Literals(["tokensAndCost", "tokens", "none"]),
  /**
   * Unused: Cerium caps no harness's turns at once. Kept because builds that require it would drop
   * manifests sent without it.
   */
  defaultConcurrency: PositiveInt,
});
export type CapabilityManifest = typeof CapabilityManifest.Type;
