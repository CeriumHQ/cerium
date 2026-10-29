import type { HubHarness, HubServer, HubSkill, ProviderId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { filterHub, groupHub, serverGist } from "../src/features/settings/hubModel.ts";

const harness = (
  provider: ProviderId,
  skills: ReadonlyArray<HubSkill>,
  servers: ReadonlyArray<HubServer> = [],
) =>
  ({
    provider,
    support: { servers: "project", tools: "project", skills: "project", status: false },
    servers,
    skills,
  }) satisfies HubHarness;

const skill = (name: string, scope: HubSkill["scope"], description?: string): HubSkill => ({
  name,
  scope,
  path: `/skills/${name}`,
  enabled: true,
  ...(description === undefined ? {} : { description }),
});

const server = (name: string, command: string, args: ReadonlyArray<string>): HubServer => ({
  name,
  scope: "user",
  transport: "stdio",
  command,
  args,
  env: [],
  headers: [],
  enabled: true,
  disabledTools: [],
});

describe("groupHub", () => {
  const harnesses = [
    harness("claude", [skill("grill-me", "project"), skill("Zeta", "user")]),
    harness("codex", [skill("Grill-Me", "user"), skill("alpha", "bundled"), skill("beta", "user")]),
  ];

  it("lists a skill once across harnesses, placed where its most local copy is", () => {
    const groups = groupHub(harnesses, (each) => each.skills);
    expect(groups.map((group) => [group.name, group.place, group.entries.length])).toEqual([
      ["grill-me", "project", 2],
      ["beta", "user", 1],
      ["Zeta", "user", 1],
      ["alpha", "bundled", 1],
    ]);
  });

  it("filters by harness and by name or description", () => {
    const groups = groupHub(
      [...harnesses, harness("opencode", [skill("docs", "user", "Writes the changelog")])],
      (each) => each.skills,
    );
    expect(filterHub(groups, { query: "", provider: "claude" }).map((group) => group.name)).toEqual([
      "grill-me",
      "Zeta",
    ]);
    expect(filterHub(groups, { query: "CHANGELOG", provider: undefined }).map((group) => group.name)).toEqual(
      ["docs"],
    );
  });
});

describe("serverGist", () => {
  it("cuts absolute paths to their file names and keeps the rest", () => {
    expect(
      serverGist(server("pen", "C:\\Programs\\Pen\\mcp.exe", ["--app", "desktop", "/opt/x/run.js"])),
    ).toBe("mcp.exe --app desktop run.js");
    expect(serverGist(server("npx", "npx", ["-y", "@scope/pkg"]))).toBe("npx -y @scope/pkg");
  });
});
