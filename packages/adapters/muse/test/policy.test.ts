import { describe, expect, it } from "@effect/vitest";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import type { ApprovalChoice, ApprovalRequestParams } from "@muse-code/sdk/dist/src/msp.js";

import {
  accessPolicy,
  approvalSummary,
  ceriumEfforts,
  choiceOutcome,
  decisionOutcome,
  fingerprintVerdict,
  isTrustedTool,
  pickApprovalChoice,
  serveArgs,
  toMuseEffort,
  toSessionMcp,
} from "../src/policy.ts";

const choice = (choiceId: string, decision: string, scope: string): ApprovalChoice =>
  ({ choiceId, decision, scope, label: choiceId }) as ApprovalChoice;

/** The choices Muse offers a shell stage. */
const shellChoices = [
  choice("once", "approved", "once"),
  choice("session", "approvedForSession", "session"),
  choice("always", "approved", "localPersistent"),
  choice("deny", "denied", "once"),
  choice("abort", "abort", "once"),
];

const request = (subject: Record<string, unknown>, extra: Partial<ApprovalRequestParams> = {}) =>
  ({
    approvalId: "a1",
    currentRequirementId: { approvalId: "a1", sourceIndex: 0 },
    rawArgs: "{}",
    toolName: "shell",
    subject,
    ...extra,
  }) as unknown as ApprovalRequestParams;

describe("access modes", () => {
  it("keeps read-only sessions from writing or running anything", () => {
    expect(accessPolicy("readOnly")).toEqual({
      permissionProfile: ":read-only",
      approvalMode: "promptUnmatched",
      serveFlags: ["--disable-write", "--disable-shell"],
    });
  });

  it("keeps a human as the reviewer when asking", () => {
    expect(accessPolicy("ask").permissionProfile).toBe(":ask-me");
    expect(accessPolicy("acceptEdits")).toEqual(accessPolicy("ask"));
  });

  it("runs full access unrestricted, unasked and unsandboxed", () => {
    expect(accessPolicy("fullAccess")).toEqual({
      permissionProfile: ":unrestricted",
      approvalMode: "allowAll",
      serveFlags: ["--disable-sandbox"],
    });
    expect(serveArgs({ access: "fullAccess" })).toContain("--disable-sandbox");
  });
});

describe("serveArgs", () => {
  const args = serveArgs({ access: "readOnly", appendSystemPrompt: 'Say "hi"' });

  it("turns native subagents off and skips user-input dialogs", () => {
    expect(args.slice(0, 2)).toEqual(["serve", "--disable-request-user-input"]);
    expect(args).toEqual(
      expect.arrayContaining([
        'run.subagent_delegation_mode="off"',
        'run.workflow_trigger_mode="off"',
        "agents.execution_capacity=1",
        "--disable-write",
        "--disable-shell",
      ]),
    );
  });

  it("adds Cerium's prompt as JSON, beside Muse's own instructions", () => {
    expect(args.slice(-2)).toEqual(["-c", 'run.developer_prompt="Say \\"hi\\""']);
    expect(serveArgs({ access: "ask" })).not.toContain("--disable-write");
  });
});

describe("toSessionMcp", () => {
  it("maps Cerium's bus onto streamable HTTP with its header", () => {
    expect(
      toSessionMcp({ type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } }),
    ).toEqual({
      transport: "streamableHttp",
      url: "http://127.0.0.1:1/mcp",
      headers: { Authorization: "Bearer t" },
    });
    expect(toSessionMcp({ type: "stdio", command: "node", args: ["s.js"] })).toEqual({
      transport: "stdio",
      command: "node",
      args: ["s.js"],
    });
  });
});

describe("efforts", () => {
  it("passes shared names through and clamps to the nearest tier the model offers", () => {
    expect(toMuseEffort("high", ["low", "medium", "high"])).toBe("high");
    expect(toMuseEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(toMuseEffort("minimal", ["none", "low", "high"])).toBe("low");
    // A tie goes to the lower tier.
    expect(toMuseEffort("medium", ["low", "high"])).toBe("low");
    expect(toMuseEffort("xhigh")).toBe("xhigh");
  });

  it("lists only the tiers Cerium has names for", () => {
    expect(ceriumEfforts(["none", "low", "max", "ultra"])).toEqual(["low", "max"]);
    expect(ceriumEfforts("unknown")).toEqual([]);
    expect(ceriumEfforts(undefined)).toEqual([]);
  });
});

describe("approval choices", () => {
  it("never picks a choice that writes a lasting rule", () => {
    expect(pickApprovalChoice(shellChoices, { decision: "allow", scope: "once" })?.choiceId).toBe("once");
    expect(pickApprovalChoice(shellChoices, { decision: "allow", scope: "session" })?.choiceId).toBe(
      "session",
    );
  });

  it("falls back to a one-time approval when no session grant is offered", () => {
    const choices = [choice("once", "approved", "once"), choice("deny", "denied", "once")];
    expect(pickApprovalChoice(choices, { decision: "allow", scope: "session" })?.choiceId).toBe("once");
  });

  it("denies, aborting only when no plain denial is offered", () => {
    expect(pickApprovalChoice(shellChoices, { decision: "deny", scope: "once" })?.choiceId).toBe("deny");
    expect(
      pickApprovalChoice([choice("abort", "abort", "once")], { decision: "deny", scope: "once" })?.choiceId,
    ).toBe("abort");
  });

  it("denies an allow that has no approving choice", () => {
    expect(
      pickApprovalChoice([choice("deny", "denied", "once")], { decision: "allow", scope: "once" })?.choiceId,
    ).toBe("deny");
  });

  it("reads back what a choice or another party decided", () => {
    expect(choiceOutcome(choice("s", "approvedForSession", "session"))).toEqual({
      decision: "allow",
      scope: "session",
    });
    expect(choiceOutcome(choice("d", "denied", "once"))).toEqual({ decision: "deny", scope: "once" });
    expect(decisionOutcome("approved")).toEqual({ decision: "allow", scope: "once" });
    expect(decisionOutcome("approvedByRule")).toEqual({ decision: "allow", scope: "session" });
  });
});

describe("approvalSummary", () => {
  it("names the stage of a compound command being asked about", () => {
    const summary = approvalSummary(
      request({
        kind: "shell",
        command: "npm test && rm -rf dist",
        stages: [
          { requirementId: { approvalId: "a1", sourceIndex: 1 }, argv: ["npm", "test"] },
          { requirementId: { approvalId: "a1", sourceIndex: 0 }, argv: ["rm", "-rf", "dist"] },
        ],
      }),
    );
    expect(summary).toBe("Run `rm -rf dist`");
  });

  it("describes file, network and tool requests in one line", () => {
    expect(approvalSummary(request({ kind: "fileAccess", access: "write", path: "/etc/hosts" }))).toBe(
      "Write /etc/hosts",
    );
    expect(approvalSummary(request({ kind: "network", host: "example.com", port: 443 }))).toBe(
      "Connect to example.com:443",
    );
    expect(approvalSummary(request({ kind: "tool", toolName: "mcp__docs__search" }))).toBe(
      "Use mcp__docs__search",
    );
    expect(approvalSummary(request({ kind: "shell", command: "x".repeat(300) }))).toHaveLength(200);
  });
});

describe("isTrustedTool", () => {
  it("trusts only the injected servers' MCP tools", () => {
    expect(isTrustedTool(request({ kind: "tool", toolName: "mcp__cerium__spawn_agent" }), ["cerium"])).toBe(
      true,
    );
    expect(isTrustedTool(request({ kind: "tool", toolName: "mcp__ceriumx__run" }), ["cerium"])).toBe(false);
    expect(
      isTrustedTool(request({ kind: "shell", command: "ls" }, { toolName: "mcp__cerium__x" }), ["cerium"]),
    ).toBe(false);
  });
});

describe("fingerprintVerdict", () => {
  it("accepts the pinned schema, and newer hosts as additive", () => {
    expect(fingerprintVerdict(EXPECTED_SCHEMA_FINGERPRINT, "1.4.8")).toBe("exact");
    expect(fingerprintVerdict("other", "1.4.10")).toBe("additive");
  });

  it("refuses a host at or below the SDK's release that serves another schema", () => {
    expect(fingerprintVerdict("other", "1.4.8")).toBe("incompatible");
    expect(fingerprintVerdict("other", "1.4.2")).toBe("incompatible");
  });
});
