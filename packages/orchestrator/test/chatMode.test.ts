import type { AgentInfo, Mention } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeFakeAdapter } from "@cerium/harness/testing";
import { Orchestrator } from "../src/index.ts";
import { renderTurn, systemPrompt } from "../src/prompts.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const fakeLead: AgentInfo = {
  id: "agt_lead" as AgentInfo["id"],
  threadId: "thr_chat" as AgentInfo["threadId"],
  role: "lead",
  provider: "claude",
  model: "sonnet",
  access: "readOnly",
  state: "idle",
  createdAt: 0,
  updatedAt: 0,
};

describe("Chat mode prompt, mentions, and Move to Work", () => {
  it("gives chat leads a dedicated system prompt without repo-editing instructions", () => {
    const prompt = systemPrompt(fakeLead, "cerium", { mode: "chat" });
    assert.include(prompt, "Cerium Chat");
    assert.include(prompt, "list_projects");
    assert.include(prompt, "list_pull_requests");
    assert.include(prompt, "list_issues");
    assert.include(prompt, "read_thread");
    assert.include(prompt, "@project");
    assert.include(prompt, "@model");
    assert.notInclude(prompt, "workspace_status");
    assert.notInclude(prompt, "project_run");
  });

  it("renders ProjectMention and ModelMention metadata into user turns", () => {
    const mentions: ReadonlyArray<Mention> = [
      { _tag: "ProjectMention", name: "cerium", path: "/Users/dev/cerium" },
      { _tag: "ModelMention", provider: "codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    ];
    const rendered = renderTurn([
      {
        _tag: "FromUser",
        text: "Inspect @cerium and ask @gpt-6.1-sol to review",
        mentions,
      },
    ]);
    assert.include(rendered, "Referenced projects (read-only):");
    assert.include(rendered, "- @cerium: /Users/dev/cerium");
    assert.include(rendered, "Referenced models:");
    assert.include(rendered, "provider: codex, model: gpt-6.1-sol");
  });

  it.live("moves an existing chat thread to work in-place and notifies the agent to implement", () => {
    const claude = makeFakeAdapter("claude");
    const codex = makeFakeAdapter("codex");
    const projectDir = mkdtempSync(join(tmpdir(), "cerium-move-work-"));

    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;

      const { thread, lead } = yield* orchestrator.createThread({
        title: "Architecture brainstorm",
        mode: "chat",
        lead: { provider: "claude", model: "sonnet", effort: "medium", access: "readOnly" },
      });

      assert.strictEqual(thread.mode, "chat");

      yield* orchestrator.sendUserMessage(lead.id, "Let's design a faster cache.");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.agentId === lead.id &&
            event.payload._tag === "AgentStateChanged" &&
            event.payload.state === "idle",
        ),
      );
      assert.include(claude.sessions[0]?.options.appendSystemPrompt ?? "", "Cerium Chat");

      const moved = yield* orchestrator.moveChatToWork({
        threadId: thread.id,
        cwd: projectDir,
        lead: {
          provider: "codex",
          model: "gpt-5.4",
          effort: "high",
          access: "auto",
        },
        implement: {
          message: "Use an LRU map bounded to 500 entries.",
          note: "Implement this cache in the project.",
        },
      });

      assert.strictEqual(moved.thread.id, thread.id);
      assert.strictEqual(moved.thread.mode, "work");
      assert.strictEqual(moved.thread.cwd, projectDir);
      assert.strictEqual(moved.lead.provider, "codex");
      assert.strictEqual(moved.lead.model, "gpt-5.4");
      assert.strictEqual(moved.lead.access, "auto");

      yield* waitFor((events) => {
        const movedIndex = events.findIndex((e) => e.payload._tag === "WorkspaceMoved");
        if (movedIndex < 0) return undefined;
        return events
          .slice(movedIndex + 1)
          .find((event) => event.agentId === lead.id && event.payload._tag === "TurnCompleted");
      });

      const workSession = codex.sessions[0];
      assert.isDefined(workSession);
      assert.strictEqual(workSession?.options.cwd, projectDir);
      assert.strictEqual(workSession?.options.access, "auto");
      assert.include(workSession?.options.appendSystemPrompt ?? "", "lead agent");
      assert.notInclude(workSession?.options.appendSystemPrompt ?? "", "You are in Cerium Chat");

      const sent = workSession?.sent.join("\n") ?? "";
      assert.include(sent, "This chat was moved to Work");
      assert.include(sent, "Implement this cache in the project.");
      assert.include(sent, "Use an LRU map bounded to 500 entries.");

      const storedEvents = (yield* store.listEvents(lead.id)).map((e) => e.payload._tag);
      assert.include(storedEvents, "WorkspaceMoved");
    }).pipe(Effect.provide(testLayer([claude.adapter, codex.adapter])), Effect.scoped);
  });
});
