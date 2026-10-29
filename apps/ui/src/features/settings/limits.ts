import type { LimitPolicy } from "@cerium/protocol";

/** What a thread does when its harness's usage limit runs out, as settings, menus and automations name it. */
export const limitPolicies: ReadonlyArray<{
  readonly value: LimitPolicy;
  readonly label: string;
  readonly hint: string;
  /** The hint for a row too narrow for it: the model menu's. */
  readonly short: string;
}> = [
  {
    value: "wait",
    label: "Wait",
    hint: "Pause until the limit resets, then go on in the same session",
    short: "Resume when it resets",
  },
  {
    value: "failover",
    label: "Switch",
    hint: "Go on at once with the next model on your roster from another harness",
    short: "Move to another harness",
  },
  { value: "off", label: "Stop", hint: "End the turn with the error", short: "End with the error" },
];

export const limitLabel: Record<LimitPolicy, string> = {
  wait: "Wait and resume",
  failover: "Switch harness",
  off: "Stop",
};

/** The policy threads follow until they choose one. */
export const DEFAULT_LIMIT_POLICY: LimitPolicy = "wait";
