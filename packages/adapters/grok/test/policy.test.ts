import { withCommand } from "@cerium/adapter-acp";
import type { SessionOptions } from "@cerium/harness";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { skillsOf } from "../src/aside.ts";
import { completionArgs } from "../src/complete.ts";
import { grokReady, grokSessionParams, READ_ONLY_RULE } from "../src/harness.ts";
import { authStatusOf } from "../src/probe.ts";
import { reportOf } from "../src/usage.ts";

const options = (access: SessionOptions["access"], appendSystemPrompt?: string): SessionOptions => ({
  cwd: "/work",
  model: "grok-4.7",
  access,
  mcpServers: {},
  includeUserMcpServers: false,
  ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
});

describe("Grok session options", () => {
  it("always says whether Grok approves on its own, whatever the user's own setting", () => {
    expect(grokSessionParams(options("ask"))).toEqual({ _meta: { yoloMode: false, autoMode: false } });
    expect(grokSessionParams(options("auto"))).toEqual({ _meta: { yoloMode: false, autoMode: true } });
    expect(grokSessionParams(options("fullAccess"))).toEqual({ _meta: { yoloMode: true, autoMode: false } });
  });

  it("tells a read-only session's model before Cerium's instructions", () => {
    expect(grokSessionParams(options("readOnly", "Be brief."))).toEqual({
      _meta: { yoloMode: false, autoMode: false, rules: `${READ_ONLY_RULE}\n\nBe brief.` },
    });
  });
});

describe("Grok readiness", () => {
  it("settles a server once it has connected or failed to, and the whole session on mcp_initialized", () => {
    const status = (name: string, status: string) => grokReady("_x.ai/mcp/server_status", { name, status });
    expect(status("cerium", "initializing")).toBeUndefined();
    expect(status("cerium", "ready")).toBe("cerium");
    expect(status("cerium", "unavailable")).toBe("cerium");
    expect(status("cerium", "needsauth")).toBe("cerium");
    expect(grokReady("_x.ai/mcp_initialized", { mcpToolCount: 38 })).toBe(true);
    expect(grokReady("_x.ai/session_notification", { name: "cerium" })).toBeUndefined();
  });
});

describe("Grok completions", () => {
  const request = { model: "grok-4.7" };

  it("offers no tools, one turn, and asks for nothing", () => {
    expect(completionArgs(request, "/tmp/prompt.md", "low", false)).toEqual([
      "--prompt-file",
      "/tmp/prompt.md",
      "--tools",
      "",
      "--max-turns",
      "1",
      "--permission-mode",
      "dontAsk",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
      "--output-format",
      "json",
      "-m",
      "grok-4.7",
      "--reasoning-effort",
      "low",
    ]);
  });

  it("through npm's shim, quotes what a shell would split", () => {
    const args = completionArgs(request, "C:\\Temp dir\\prompt.md", undefined, true);
    expect(args.slice(0, 4)).toEqual(["--prompt-file", '"C:\\Temp dir\\prompt.md"', "--tools", '""']);
    expect(args).not.toContain("--reasoning-effort");
  });
});

describe("Grok sign-in", () => {
  it("reads the plan and how Grok is signed in, or that it isn't", () => {
    expect(authStatusOf({ authenticated: false })).toEqual({ _tag: "LoggedOut", loginCommand: "grok login" });
    expect(
      authStatusOf({ authenticated: true, meta: { subscription_tier: "SuperGrok", auth_mode: "Oidc" } }),
    ).toEqual({ _tag: "LoggedIn", method: "grok.com", plan: "SuperGrok" });
    expect(authStatusOf({ authenticated: true, meta: null })).toEqual({ _tag: "LoggedIn" });
  });
});

describe("Grok usage", () => {
  it("reads the plan's credit meter from Grok's billing answer", () => {
    const billing = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "billing.json"), "utf8"));
    expect(reportOf(billing)).toEqual(
      Option.some({
        plan: "SuperGrok",
        meters: [
          {
            label: "Weekly",
            usedPercent: 9,
            resetsAt: Date.parse("2026-11-06T01:13:05.189+00:00"),
            windowMinutes: 7 * 24 * 60,
          },
        ],
      }),
    );
  });

  it("has no meter for an account without a plan's credits", () => {
    expect(reportOf({ config: { prepaidBalance: { val: 0 } } } as never)).toEqual(Option.none());
  });
});

describe("Grok skills", () => {
  it("lists the commands that have a skill file", () => {
    expect(
      skillsOf([
        {
          name: "review",
          description: "Review the diff ",
          _meta: { path: "/home/.grok/skills/review/SKILL.md" },
        },
        { name: "compact", description: "Compact the conversation" },
        { name: "init", _meta: { path: "" } },
      ]),
    ).toEqual([
      { name: "review", description: "Review the diff", path: "/home/.grok/skills/review/SKILL.md" },
    ]);
  });

  it("runs a picked skill as Grok's slash command", () => {
    const extras = { skills: [{ name: "review", path: "/home/.grok/skills/review/SKILL.md" }] };
    expect(withCommand("$review the last commit", extras, new Set(["review"]))).toBe(
      "/review the last commit",
    );
    // A `$` the user typed, or a skill Grok doesn't offer, stays as written.
    expect(withCommand("$review the last commit", undefined, new Set(["review"]))).toBe(
      "$review the last commit",
    );
    expect(withCommand("$review the last commit", extras, new Set())).toBe("$review the last commit");
  });
});
