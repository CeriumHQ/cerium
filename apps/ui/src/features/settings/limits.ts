import type { LimitPolicy } from "@cerium/protocol";

/** What a thread does when its harness's usage limit runs out, as settings, menus and automations name it. */
export const limitPolicies: ReadonlyArray<{
  readonly value: LimitPolicy;
  readonly label: string;
  readonly hint: string;
}> = [
  { value: "wait", label: "Wait", hint: "Pause until the limit resets, then go on in the same session" },
  {
    value: "failover",
    label: "Switch",
    hint: "Go on at once with the next model on your roster from another harness",
  },
  { value: "off", label: "Stop", hint: "End the turn with the error" },
];

export const limitLabel: Record<LimitPolicy, string> = {
  wait: "Wait and resume",
  failover: "Switch harness",
  off: "Stop",
};

/** The policy threads follow until they choose one. */
export const DEFAULT_LIMIT_POLICY: LimitPolicy = "wait";
