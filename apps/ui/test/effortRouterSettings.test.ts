import { describe, expect, it } from "@effect/vitest";

import { advisorModelHint } from "../src/features/settings/advisorModel.ts";
import { OPENROUTER_KEYS_URL, routerHint } from "../src/features/settings/effortRouterModel.ts";

describe("effort router hint", () => {
  const base = { enabled: false, hasKey: false, local: true, machineName: undefined } as const;

  it("says nothing while the status loads or once a key is saved", () => {
    expect(routerHint({ ...base, hasKey: undefined })).toBeUndefined();
    expect(routerHint({ ...base, hasKey: true })).toBeUndefined();
    expect(routerHint({ ...base, hasKey: true, enabled: true })).toBeUndefined();
  });

  it("tells this computer that saving a key turns the router on", () => {
    expect(routerHint(base)).toEqual({
      text: "Turns on when you save an OpenRouter key below.",
      attention: false,
    });
  });

  it("points another device at the computer that holds the key", () => {
    expect(routerHint({ ...base, local: false, machineName: "Studio" })?.text).toBe(
      "Needs an OpenRouter key from Studio.",
    );
    expect(routerHint({ ...base, local: false })?.text).toBe("Needs an OpenRouter key from that computer.");
  });

  it("flags a router left on without a key", () => {
    expect(routerHint({ ...base, enabled: true })).toMatchObject({ attention: true });
  });

  it("links to OpenRouter's own key page", () => {
    expect(new URL(OPENROUTER_KEYS_URL).hostname).toBe("openrouter.ai");
  });
});

describe("advisor model hint", () => {
  const picked = { provider: "claude", model: "claude-opus-5-5" } as const;

  it("asks for a model when none is chosen", () => {
    expect(advisorModelHint({ picked: undefined, listed: false, idle: false, loading: false })).toBe(
      "Choose a model so agents can ask it.",
    );
  });

  it("warns when the pick's harness can't run", () => {
    expect(advisorModelHint({ picked, listed: true, idle: true, loading: false })).toBe(
      "Claude can't run right now.",
    );
  });

  it("warns when the picked model is no longer listed, once the lists have arrived", () => {
    expect(advisorModelHint({ picked, listed: false, idle: false, loading: false })).toBe(
      "claude-opus-5-5 isn't offered anymore. Choose another model.",
    );
    expect(advisorModelHint({ picked, listed: false, idle: false, loading: true })).toBeUndefined();
  });

  it("says nothing for a listed model whose harness runs", () => {
    expect(advisorModelHint({ picked, listed: true, idle: false, loading: false })).toBeUndefined();
  });
});
