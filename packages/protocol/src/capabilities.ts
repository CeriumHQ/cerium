import { Schema } from "effect";

import { ProviderId } from "./ids.ts";

export const ReasoningEffort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = typeof ReasoningEffort.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * What an adapter's harness can do. The UI and orchestrator branch on these flags
 * instead of on provider names (docs/architecture.md §2.4).
 */
export const CapabilityManifest = Schema.Struct({
  provider: ProviderId,
  /** Installed harness versions Cerium accepts; above `testedMaximum` is allowed but flagged. */
  harnessVersion: Schema.Struct({
    minimum: Schema.NonEmptyString,
    testedMaximum: Schema.NonEmptyString,
  }),
  session: Schema.Struct({
    resume: Schema.Boolean,
    fork: Schema.Boolean,
  }),
  switching: Schema.Struct({
    model: Schema.Boolean,
    effort: Schema.Boolean,
    /** Effort can change mid-session without invalidating the provider's prompt cache. */
    cacheSafeEffort: Schema.Boolean,
  }),
  input: Schema.Struct({
    images: Schema.Boolean,
  }),
  permissions: Schema.Struct({
    /** How approval requests reach Cerium. */
    approvals: Schema.Literals(["callback", "protocol", "hookBridge"]),
    readOnlyMode: Schema.Boolean,
  }),
  mcpInjection: Schema.Boolean,
  nativeSubagents: Schema.Literals(["disableable", "notDisableable"]),
  usageReporting: Schema.Literals(["tokensAndCost", "tokens", "none"]),
  /** Default account-wide concurrency cap before plan-tier adjustment. */
  defaultConcurrency: PositiveInt,
});
export type CapabilityManifest = typeof CapabilityManifest.Type;
