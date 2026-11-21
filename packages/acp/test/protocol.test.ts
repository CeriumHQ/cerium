import type { SessionOptions } from "@cerium/harness";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  acpMcpServers,
  answerOnce,
  count,
  effortChoice,
  hasHttpMcp,
  onceOptions,
  promptBlocks,
  readConfigOptions,
  record,
  refusal,
  string,
  toStopReason,
  usableStatus,
} from "../src/index.ts";
import { harness } from "./support.ts";

const options = (access: SessionOptions["access"]): SessionOptions => ({
  cwd: "/repo",
  model: "m",
  access,
  includeUserMcpServers: true,
  mcpServers: {
    cerium: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } },
    tools: { type: "stdio", command: "tools", args: ["--serve"], env: { TOKEN: "y" } },
  },
  trustedMcpServers: ["cerium"],
});

describe("ACP protocol helpers", () => {
  it("formats injected MCP servers as ACP lists them", () => {
    const servers = acpMcpServers(options("ask"));
    expect(servers).toEqual([
      {
        name: "cerium",
        type: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
      { name: "tools", command: "tools", args: ["--serve"], env: [{ name: "TOKEN", value: "y" }] },
    ]);
    expect(hasHttpMcp(servers)).toBe(true);
    expect(acpMcpServers(options("ask"), { tagStdio: true })[1]).toMatchObject({ type: "stdio" });
    // Read-only sessions get only the servers whose tools need no approval.
    expect(acpMcpServers(options("readOnly")).map(({ name }) => name)).toEqual(["cerium"]);
  });

  it("encodes a turn's text and images as content blocks", () => {
    expect(promptBlocks("Look", [{ path: "/a.png", mediaType: "image/png", data: "eA==" }])).toEqual([
      { type: "text", text: "Look" },
      { type: "image", mimeType: "image/png", data: "eA==" },
    ]);
    expect(promptBlocks("Only text")).toEqual([{ type: "text", text: "Only text" }]);
  });

  it("maps ACP's stop reasons", () => {
    expect(toStopReason({ stopReason: "end_turn" })).toBe("completed");
    expect(toStopReason({ stopReason: "stop_sequence" })).toBe("completed");
    expect(toStopReason({ stopReason: "cancelled" })).toBe("interrupted");
    expect(toStopReason({ stopReason: "max_tokens" })).toBe("maxTurns");
    expect(toStopReason({ stopReason: "max_turn_requests" })).toBe("maxTurns");
    expect(toStopReason({ stopReason: "refusal" })).toBe("error");
    expect(toStopReason(undefined)).toBe("error");
  });

  it("answers permission requests with once-only options only", () => {
    const params = {
      options: [
        { kind: "allow_always", optionId: "always" },
        { kind: "allow_once", optionId: "once" },
        { kind: "reject_always", optionId: "never" },
        { kind: "reject_once", optionId: "no" },
      ],
    };
    const once = onceOptions(params);
    expect(once).toEqual({ allow: "once", deny: "no" });
    const answer = answerOnce(once);
    expect(answer({ allow: true, cancelled: false })).toEqual({
      allowed: true,
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });
    expect(answer({ allow: false, cancelled: false })).toEqual({
      allowed: false,
      result: { outcome: { outcome: "selected", optionId: "no" } },
    });
    expect(answer({ allow: false, cancelled: true })).toEqual({
      allowed: false,
      result: { outcome: { outcome: "cancelled" } },
    });
    const lasting = onceOptions({ options: [{ kind: "allow_always", optionId: "always" }] });
    expect(answerOnce(lasting)({ allow: true, cancelled: false })).toEqual({
      allowed: false,
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(refusal(lasting)).toEqual({ outcome: { outcome: "cancelled" } });
    expect(refusal(once)).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });

  it("reads config options, skipping what it can't", () => {
    expect(
      readConfigOptions([
        {
          id: "model",
          currentValue: "a",
          options: [{ value: "a", name: "A", _meta: { images: true } }, { value: "" }, { name: "no value" }],
        },
        { id: "effort", currentValue: "high" },
        { id: "broken" },
        "nonsense",
      ]),
    ).toEqual([
      { id: "model", currentValue: "a", options: [{ value: "a", name: "A", meta: { images: true } }] },
      { id: "effort", currentValue: "high", options: [] },
    ]);
    expect(readConfigOptions(undefined)).toEqual([]);
  });

  it("picks an offered effort, with minimal standing for the lowest", () => {
    expect(effortChoice(["low", "high"], "high")).toBe("high");
    expect(effortChoice(["low", "high"], "minimal")).toBe("low");
    expect(effortChoice(["minimal", "high"], "minimal")).toBe("minimal");
    expect(effortChoice(["low", "high"], "max")).toBeUndefined();
    expect(effortChoice([], "minimal")).toBeUndefined();
  });

  it("narrows loose JSON without throwing", () => {
    expect(record({ a: 1 })).toEqual({ a: 1 });
    expect(record([1])).toBeUndefined();
    expect(record(null)).toBeUndefined();
    expect(string("")).toBeUndefined();
    expect(string("x")).toBe("x");
    expect(count(3)).toBe(3);
    expect(count(-1)).toBeUndefined();
    expect(count(1.5)).toBeUndefined();
  });

  it("explains why a harness can't run a session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(
            usableStatus(harness, { _tag: "HarnessMissing", provider: "devin", installHint: "" }),
          ),
        ).toMatchObject({
          _tag: "HarnessUnavailable",
          reason: "notInstalled",
          message: "Install the fixture.",
        });
        const installed = {
          _tag: "HarnessInstalled",
          provider: "devin",
          executablePath: "/bin/fixture",
          version: "1.0.0",
        } as const;
        expect(
          yield* Effect.flip(
            usableStatus(harness, {
              ...installed,
              auth: { _tag: "LoggedOut", loginCommand: "fixture login" },
            }),
          ),
        ).toMatchObject({ reason: "loggedOut", message: "Fixture is not signed in." });
        expect(yield* usableStatus(harness, { ...installed, auth: { _tag: "LoggedIn" } })).toMatchObject(
          installed,
        );
      }),
    ));
});
