import { pickOption, type InitializeResponse, type ToolCallState } from "@cerium/adapter-acp";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { mcpServersFromConfig } from "../src/config.ts";
import {
  grokArgs,
  grokAuthMethod,
  grokEnvironment,
  grokHarness,
  grokSignIn,
  isWithheldGrokTool,
} from "../src/harness.ts";
import { skillsFromList } from "../src/skills.ts";
import { billingReport } from "../src/usage.ts";

const initialized = (
  methods: ReadonlyArray<string>,
  defaultAuthMethodId: string | null,
): InitializeResponse => ({
  protocolVersion: 1,
  authMethods: methods.map((id) => ({ id, name: id })),
  _meta: { defaultAuthMethodId },
});

describe("grokSignIn", () => {
  it("authenticates headless with the method Grok names as default", () => {
    expect(grokSignIn(initialized(["grok.com", "cached_token"], "cached_token"))).toEqual({
      _tag: "Authenticate",
      methodId: "cached_token",
      meta: { headless: true },
    });
    expect(grokAuthMethod(initialized(["xai.api_key", "grok.com"], "xai.api_key"))).toBe("apiKey");
  });

  it("falls back to a cached login when no default is named", () => {
    expect(grokSignIn(initialized(["grok.com", "cached_token"], null))).toMatchObject({
      methodId: "cached_token",
    });
  });

  it("reads a browser-only login as signed out", () => {
    expect(grokSignIn(initialized(["grok.com"], null))).toEqual({ _tag: "SignedOut" });
    expect(grokSignIn(initialized(["oidc"], "oidc"))).toEqual({ _tag: "SignedOut" });
  });
});

describe("grok's command line", () => {
  it("is always an agent of its own on stdio, with subagents and its question tool off", () => {
    expect(grokArgs()).toEqual(["agent", "--no-leader", "stdio"]);
    expect(grokEnvironment({ purpose: "session", access: "ask" })).toEqual({
      GROK_SUBAGENTS: "0",
      GROK_ASK_USER_QUESTION: "0",
      GROK_DISABLE_AUTOUPDATER: "1",
    });
  });

  it("sandboxes read-only agents, and keeps memory and the sandbox out of Cerium's own jobs", () => {
    expect(grokEnvironment({ purpose: "session", access: "readOnly" })).toMatchObject({
      GROK_SANDBOX: "read-only",
    });
    const completion = grokEnvironment({ purpose: "completion", access: "readOnly" });
    expect(completion).toMatchObject({ GROK_MEMORY: "0" });
    expect(completion["GROK_SANDBOX"]).toBeUndefined();
  });

  it("appends Cerium's instructions to agents, replaces the prompt for completions, and sets the approval mode", () => {
    const base = { cwd: "/work", includeUserMcpServers: false, injectedMcpServers: [] } as const;
    const agent = grokHarness.command({
      ...base,
      purpose: "session",
      access: "ask",
      appendSystemPrompt: "Be Cerium.",
    });
    expect(agent.initializeMeta).toEqual({ rules: "Be Cerium." });
    expect(agent.sessionMeta).toEqual({ yoloMode: false, autoMode: false });
    const completion = grokHarness.command({
      ...base,
      purpose: "completion",
      access: "readOnly",
      appendSystemPrompt: "Title it.",
    });
    expect(completion.initializeMeta).toEqual({ systemPromptOverride: "Title it." });
    expect(grokHarness.command({ ...base, purpose: "session", access: "fullAccess" }).sessionMeta).toEqual({
      yoloMode: true,
      autoMode: false,
    });
  });
});

describe("permissions", () => {
  const options = [
    {
      optionId: "enable-always-approve",
      name: "Yes, and don't ask again for anything",
      kind: "allow_once" as const,
    },
    { optionId: "allow-once", name: "Yes", kind: "allow_once" as const },
    { optionId: "always-allow", name: "Always", kind: "allow_always" as const },
    { optionId: "reject-once", name: "No", kind: "reject_once" as const },
  ];

  it("never answers once with Grok's always-approve switch", () => {
    expect(pickOption(options, { decision: "allow" })?.optionId).toBe("allow-once");
    expect(pickOption(options, { decision: "deny" })?.optionId).toBe("reject-once");
  });

  it("withholds subagents and Grok's own question tool", () => {
    const call = (kind: string): ToolCallState => ({
      toolCallId: "c",
      content: [],
      locations: [],
      meta: { "x.ai/tool": { name: kind, kind } },
    });
    expect(isWithheldGrokTool(call("task"))).toBe(true);
    expect(isWithheldGrokTool(call("ask_user"))).toBe(true);
    expect(isWithheldGrokTool(call("read"))).toBe(false);
  });
});

describe("mcpServersFromConfig", () => {
  it("passes enabled stdio and HTTP servers, expanding variables and bearer tokens", () => {
    const servers = mcpServersFromConfig(
      {
        mcp_servers: {
          files: { command: "npx", args: ["-y", "files", "${HOME}"], env: { TOKEN: "$SECRET" } },
          web: {
            url: "https://mcp.example/v1",
            headers: { "X-Team": "a" },
            bearer_token_env_var: "WEB_TOKEN",
          },
          off: { command: "x", enabled: false },
        },
      },
      { HOME: "/home/me", SECRET: "s3", WEB_TOKEN: "t0k" },
    );
    expect(servers).toEqual([
      {
        name: "files",
        command: "npx",
        args: ["-y", "files", "/home/me"],
        env: [{ name: "TOKEN", value: "s3" }],
      },
      {
        type: "http",
        name: "web",
        url: "https://mcp.example/v1",
        headers: [
          { name: "X-Team", value: "a" },
          { name: "Authorization", value: "Bearer t0k" },
        ],
      },
    ]);
  });

  it("is empty without servers", () => {
    expect(mcpServersFromConfig({})).toEqual([]);
  });
});

describe("billingReport", () => {
  it("reads the period's credit share and when it resets", () => {
    const report = billingReport({
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-10-27T00:00:00Z",
          end: "2026-11-03T00:00:00Z",
        },
      },
      subscriptionTier: "SuperGrok",
    });
    expect(Option.getOrThrow(report)).toEqual({
      plan: "SuperGrok",
      meters: [{ label: "Weekly", usedPercent: 42.5, resetsAt: Date.parse("2026-11-03T00:00:00Z") }],
    });
  });

  it("falls back to the legacy monthly limit, and is none without one", () => {
    expect(
      Option.getOrThrow(billingReport({ config: { monthlyLimit: { val: 2000 }, used: { val: 500 } } })),
    ).toEqual({
      meters: [{ label: "Monthly", usedPercent: 25 }],
    });
    expect(Option.isNone(billingReport({ config: null }))).toBe(true);
  });
});

describe("skillsFromList", () => {
  it("lists enabled skills by their id", () => {
    expect(
      skillsFromList({
        skills: [
          {
            id: "review",
            display_name: "Review",
            description: "Reviews a diff",
            path: "/home/me/.grok/skills/review/SKILL.md",
          },
          { id: "old", enabled: false },
          { name: "" },
        ],
      }),
    ).toEqual([
      { name: "review", description: "Reviews a diff", path: "/home/me/.grok/skills/review/SKILL.md" },
    ]);
  });
});
