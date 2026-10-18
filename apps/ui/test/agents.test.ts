import { describe, expect, it } from "@effect/vitest";

import { agentMenuPlan, hasAgentMenu } from "../src/features/agents/model.ts";
import type { AgentSummary } from "../src/features/agents/model.ts";

const agent = (state: AgentSummary["state"], parentId?: string) => ({
  state,
  ...(parentId ? { parentId } : {}),
});
const row = { card: false, canMessage: true };
const card = { card: true, canMessage: true };

describe("agentMenuPlan", () => {
  it("offers a working child interrupting and stopping, but no messaging", () => {
    expect(agentMenuPlan(agent("running", "lead"), row)).toEqual({
      show: false,
      message: false,
      interrupt: "enabled",
      stop: true,
    });
  });

  it("offers the lead a message too", () => {
    expect(agentMenuPlan(agent("idle"), row)).toEqual({
      show: false,
      message: true,
      interrupt: "disabled",
      stop: true,
    });
  });

  it("leaves out Message where it can't be done", () => {
    expect(agentMenuPlan(agent("idle"), { card: false, canMessage: false }).message).toBe(false);
  });

  it("treats a queued agent as working", () => {
    expect(agentMenuPlan(agent("queued", "lead"), row).interrupt).toBe("enabled");
  });

  it("gives an ended agent no menu on a row", () => {
    for (const state of ["stopped", "failed"] as const) {
      expect(hasAgentMenu(agentMenuPlan(agent(state, "lead"), row))).toBe(false);
      expect(hasAgentMenu(agentMenuPlan(agent(state), row))).toBe(false);
    }
  });

  it("keeps only 'Show in agents panel' on an ended agent's card", () => {
    expect(agentMenuPlan(agent("stopped", "lead"), card)).toEqual({
      show: true,
      message: false,
      interrupt: "hidden",
      stop: false,
    });
  });
});
