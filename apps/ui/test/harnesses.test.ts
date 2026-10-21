import { describe, expect, it } from "@effect/vitest";

import { accountLabel } from "../src/features/settings/harnessModel.ts";

describe("accountLabel", () => {
  it("names the account by its maker and plan", () => {
    expect(accountLabel({ _tag: "LoggedIn", method: "claude.ai", plan: "max" })).toBe("Claude Max");
    expect(accountLabel({ _tag: "LoggedIn", method: "chatgpt", plan: "free" })).toBe("ChatGPT Free");
    expect(accountLabel({ _tag: "LoggedIn", method: "claude.ai", plan: "max_20x" })).toBe("Claude Max 20x");
  });

  it("reads whole without a plan", () => {
    expect(accountLabel({ _tag: "LoggedIn", method: "cursorLogin" })).toBe("Cursor account");
    expect(accountLabel({ _tag: "LoggedIn", method: "apiKey" })).toBe("API key");
    expect(accountLabel({ _tag: "LoggedIn", method: "Anthropic, OpenAI" })).toBe("Anthropic, OpenAI");
    expect(accountLabel({ _tag: "LoggedIn" })).toBe("Signed in");
  });
});
