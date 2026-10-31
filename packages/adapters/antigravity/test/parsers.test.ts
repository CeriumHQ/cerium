import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verdictFor } from "../src/hook.ts";
import { agentFile, hookCommand, mcpConfig, runArgs } from "../src/launch.ts";
import { parseModels } from "../src/models.ts";
import { signInMethod } from "../src/probe.ts";
import { firstFolder, listAntigravitySessions, summariesPath } from "../src/sessions.ts";
import { listAntigravitySkills } from "../src/skills.ts";
import { mcpToolName } from "../src/tools.ts";
import { parseUsage } from "../src/usage.ts";

const require = createRequire(import.meta.url);

describe("parseModels", () => {
  it("reads tab- and space-separated lines, skipping the CLI's status lines", () => {
    expect(
      parseModels(
        "Fetching available models...\ngemini-3.8-flash\tGemini 3.8 Flash\ngemini-3.6-flash-high   Gemini 3.6 Flash (High)\n* gemini-3.8-pro  Gemini 3.8 Pro (default)\n",
      ),
    ).toEqual([
      {
        provider: "antigravity",
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
        efforts: ["low", "medium", "high"],
      },
      { provider: "antigravity", id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)", efforts: [] },
      {
        provider: "antigravity",
        id: "gemini-3.8-pro",
        label: "Gemini 3.8 Pro",
        efforts: ["low", "medium", "high"],
        isDefault: true,
      },
    ]);
  });

  it("lists nothing from the signed-out answer", () => {
    expect(
      parseModels("Fetching available models...\nError: Please sign in to view available models.\n"),
    ).toEqual([]);
  });
});

describe("parseUsage", () => {
  it("reads tab-separated meter rows as used shares", () => {
    const report = parseUsage(
      "Model quota\tGemini Pro\t72%\t2026-11-01T00:00:00Z\nCredits\tAI credits\t100%\t\nsome note\n",
    );
    expect(Option.getOrThrow(report)).toEqual({
      meters: [
        { label: "Model quota · Gemini Pro", usedPercent: 28, resetsAt: Date.parse("2026-11-01T00:00:00Z") },
        { label: "Credits · AI credits", usedPercent: 0 },
      ],
    });
  });

  it("is none when nothing reads as a meter", () => {
    expect(Option.isNone(parseUsage("No quota information."))).toBe(true);
  });
});

describe("conversation_summaries", () => {
  // The table as the 1.4.12 binary creates it (seen live).
  const SCHEMA =
    'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`))';

  it("lists the user's own top-level conversations, newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "cerium-agy-home-"));
    mkdirSync(join(home, "antigravity-cli"), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const database = new DatabaseSync(summariesPath(home));
    database.exec(SCHEMA);
    const insert = database.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, agent_name, parent_conversation_id, nesting_depth, last_user_input_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "a",
      "Fix the login test",
      "",
      12,
      "2026-10-30 10:00:00+00:00",
      '["file:///work/app"]',
      "",
      "",
      0,
      "2026-10-30 10:00:00+00:00",
    );
    insert.run(
      "b",
      "",
      "Why is CI red?\nmore",
      4,
      "2026-10-31 09:00:00+00:00",
      "file:///work/api",
      "",
      "",
      0,
      "2026-10-31 09:00:00+00:00",
    );
    insert.run(
      "child",
      "sub",
      "",
      2,
      "2026-10-31 09:30:00+00:00",
      "[]",
      "research",
      "b",
      1,
      "2026-10-31 09:30:00+00:00",
    );
    insert.run(
      "ours",
      "Cerium",
      "",
      2,
      "2026-10-31 09:40:00+00:00",
      "[]",
      "cerium-abc123",
      "",
      0,
      "2026-10-31 09:40:00+00:00",
    );
    database.close();
    const sessions = Effect.runSync(listAntigravitySessions(home));
    expect(sessions).toEqual([
      {
        id: "b",
        cwd: "/work/api",
        title: "Why is CI red?",
        updatedAt: Date.parse("2026-10-31T09:00:00+00:00"),
        turns: 4,
      },
      {
        id: "a",
        cwd: "/work/app",
        title: "Fix the login test",
        updatedAt: Date.parse("2026-10-30T10:00:00+00:00"),
        turns: 12,
      },
    ]);
  });

  it("lists nothing without the database", () => {
    expect(Effect.runSync(listAntigravitySessions(mkdtempSync(join(tmpdir(), "cerium-agy-empty-"))))).toEqual(
      [],
    );
    expect(firstFolder("not a uri")).toBeUndefined();
  });
});

describe("skills", () => {
  it("finds SKILL.md folders, the workspace's first", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cerium-agy-ws-"));
    const home = mkdtempSync(join(tmpdir(), "cerium-agy-gh-"));
    const add = (root: string, name: string, frontmatter: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\nBody`);
    };
    add(join(cwd, ".agents", "skills"), "review", "name: review\ndescription: Project review");
    add(join(home, "config", "skills"), "review", "name: review\ndescription: Global review");
    add(join(home, "skills"), "notes", "description: Takes notes");
    const skills = await Effect.runPromise(listAntigravitySkills(cwd, home));
    expect(skills.map(({ name, description }) => [name, description])).toEqual([
      ["review", "Project review"],
      ["notes", "Takes notes"],
    ]);
  });
});

describe("approval policy", () => {
  const context = { trusted: ["cerium"], cwd: "/work" };
  const tool = (native: string, toolName = native, path?: string) => ({ native, toolName, path });

  it("always denies native subagents and the question tool", () => {
    for (const access of ["fullAccess", "ask"] as const) {
      expect(verdictFor(access, tool("invoke_subagent"), context).verdict).toBe("deny");
      expect(verdictFor(access, tool("ask_question"), context).verdict).toBe("deny");
    }
  });

  it("lets reads and trusted servers through, and answers writes by access mode", () => {
    expect(verdictFor("readOnly", tool("read_file", "read"), context).verdict).toBe("allow");
    expect(verdictFor("readOnly", tool("cerium_cerium/spawn", "mcp__cerium__spawn"), context).verdict).toBe(
      "allow",
    );
    expect(verdictFor("readOnly", tool("run_command", "shell"), context).verdict).toBe("deny");
    expect(verdictFor("ask", tool("run_command", "shell"), context).verdict).toBe("ask");
    expect(verdictFor("acceptEdits", tool("write_file", "write", "/work/a.ts"), context).verdict).toBe(
      "allow",
    );
    expect(verdictFor("acceptEdits", tool("write_file", "write", "/etc/passwd"), context).verdict).toBe(
      "ask",
    );
    expect(verdictFor("fullAccess", tool("run_command", "shell"), context).verdict).toBe("allow");
  });

  it("names a plugin's namespaced MCP tools by their server", () => {
    expect(mcpToolName("cerium_cerium/spawn_agent", ["cerium"], "cerium")).toBe("mcp__cerium__spawn_agent");
    expect(mcpToolName("mcp_cerium_cerium_computer_read", ["cerium"], "cerium")).toBe(
      "mcp__cerium__computer_read",
    );
    expect(mcpToolName("read_file", ["cerium"], "cerium")).toBeUndefined();
  });
});

describe("launch files", () => {
  it("writes a hidden main agent that names Cerium's plugin and carries its instructions", () => {
    const agent = agentFile({
      name: "cerium-1",
      pluginDirectory: "/tmp/p/cerium",
      includeUserMcpServers: true,
      instructions: "Be Cerium.",
    });
    expect(agent).toBe(
      "---\nname: cerium-1\ndescription: Cerium's agent for one Cerium session. Removed when the session ends.\nmainAgent: true\nsubagent: false\nhidden: true\ninheritCustomizations: true\ninheritMcp: true\nplugins:\n  - /tmp/p/cerium\n---\n\n# Cerium\n\nBe Cerium.\n",
    );
  });

  it("spells Cerium's servers as mcp_config.json does", () => {
    expect(
      mcpConfig({
        cerium: { type: "http", url: "http://127.0.0.1:5/mcp", headers: { Authorization: "Bearer t" } },
        echo: { type: "stdio", command: "node", args: ["echo.js"] },
      }),
    ).toEqual({
      mcpServers: {
        cerium: { serverUrl: "http://127.0.0.1:5/mcp", headers: { Authorization: "Bearer t" } },
        echo: { command: "node", args: ["echo.js"] },
      },
    });
  });

  it("streams a turn on Cerium's agent, never with skipped permissions (which skip hooks)", () => {
    const args = runArgs({
      agent: "cerium-1",
      conversation: "c1",
      model: "m",
      effort: "minimal",
      access: "acceptEdits",
    });
    expect(args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--agent",
      "cerium-1",
      "--conversation",
      "c1",
      "--model",
      "m",
      "--effort",
      "low",
      "--mode",
      "accept-edits",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("runs the hook with Node, or with Electron as Node", () => {
    if (process.platform === "win32") return;
    expect(hookCommand("/p/hook.mjs", "/usr/bin/node", false)).toBe("'/usr/bin/node' '/p/hook.mjs'");
    expect(hookCommand("/p/hook.mjs", "/Apps/Cerium", true)).toBe(
      "ELECTRON_RUN_AS_NODE=1 '/Apps/Cerium' '/p/hook.mjs'",
    );
  });
});

describe("signInMethod", () => {
  it("tells an API key and Google Cloud from a personal account", () => {
    expect(signInMethod({ GEMINI_API_KEY: "k" }, { modelProvider: "gemini" })).toBe("apiKey");
    expect(signInMethod({ AGY_ADC_AUTH: "true" }, {})).toBe("googleCloud");
    expect(signInMethod({ GEMINI_API_KEY: "k" }, {})).toBe("google");
  });
});
