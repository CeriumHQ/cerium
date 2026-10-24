import type { AgentEvent, AgentId, ThreadId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Orchestrator, type CatalogEntry } from "../src/index.ts";
import { HarnessFailure, type HarnessAdapter } from "@cerium/harness";
import { makeFakeAdapter } from "@cerium/harness/testing";

import { recordEvents, testLayer, testStore } from "./fakes.ts";

const haiku: CatalogEntry = {
  alias: "scout",
  provider: "claude",
  model: "haiku",
  effort: "low",
  description: "Quick lookups",
};

const turnInputs = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "TurnInput" ? [event.payload.items] : [],
  );

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", effort: "high", access: "ask" },
  });
});

describe("Orchestrator", () => {
  it.live("runs a user turn on the lead and persists everything but deltas", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "AgentStateChanged" && event.payload.state === "idle"),
      );

      assert.deepStrictEqual(fake.sessions[0]?.sent, ["hello"]);
      assert.deepStrictEqual(fake.sessions[0]?.options.trustedMcpServers, ["cerium"]);
      assert.include(fake.sessions[0]?.options.appendSystemPrompt ?? "", "lead agent");
      const stored = (yield* store.listEvents(lead.id)).map((event) => event.payload._tag);
      assert.includeMembers(stored, ["SessionStarted", "TurnInput", "MessageCompleted", "TurnCompleted"]);
      assert.notInclude(stored, "MessageDelta");
      const agents = yield* orchestrator.listAgents(lead.threadId);
      assert.strictEqual(agents[0]?.providerSessionId, "fake-1");

      yield* Effect.sleep("5 millis");
      yield* orchestrator.stopAgent(lead.id);
      const stopped = (yield* orchestrator.listAgents(lead.threadId))[0];
      assert.strictEqual(stopped?.state, "stopped");
      assert.strictEqual(stopped?.updatedAt, agents[0]?.updatedAt, "stopping isn't activity");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("stops live agents as the app quits without counting it as activity", () => {
    const fake = makeFakeAdapter("claude");
    const database = join(mkdtempSync(join(tmpdir(), "cerium-quit-")), "cerium.db");
    return Effect.gen(function* () {
      const before = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { waitFor } = yield* recordEvents;
        const { lead } = yield* startWorkThread;
        yield* orchestrator.sendUserMessage(lead.id, "hello");
        yield* waitFor((events) =>
          events.find(
            (event) => event.payload._tag === "AgentStateChanged" && event.payload.state === "idle",
          ),
        );
        const agents = yield* orchestrator.listAgents(lead.threadId);
        yield* Effect.sleep("5 millis");
        return agents;
      }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);

      const after = yield* Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.listAgents(before[0]!.threadId);
      }).pipe(Effect.provide(testStore(database)));
      assert.strictEqual(after[0]?.state, "stopped");
      assert.strictEqual(after[0]?.updatedAt, before[0]?.updatedAt, "quitting isn't activity");
    });
  });

  it.live("hands the harness the user's attachments, images and skills", () => {
    const folder = mkdtempSync(join(tmpdir(), "cerium-attachments-"));
    const image = join(folder, "shot.png");
    writeFileSync(image, Uint8Array.from([137, 80, 78, 71]));
    const notes = join(folder, "notes.md");
    writeFileSync(notes, "# Notes");
    const sees = makeFakeAdapter("claude", { images: true });
    const blind = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const message = {
        attachments: [
          { path: image, name: "shot.png", mediaType: "image/png" },
          { path: notes, name: "notes.md", mediaType: "text/markdown" },
        ],
        mentions: [
          { _tag: "FileMention", path: "src/app.ts", folder: false },
          { _tag: "SkillMention", name: "review", path: "/skills/review/SKILL.md" },
        ],
      } as const;
      for (const provider of ["claude", "codex"] as const) {
        const { lead } = yield* orchestrator.createThread({
          title: provider,
          mode: "work",
          cwd: folder,
          lead: { provider, model: "m", access: "ask" },
        });
        yield* orchestrator.sendUserMessage(lead.id, "Check @src/app.ts with $review", message);
        yield* waitFor((events) =>
          events.find(
            (event) =>
              event.agentId === lead.id &&
              event.payload._tag === "AgentStateChanged" &&
              event.payload.state === "idle",
          ),
        );
        const turn = turnInputs(yield* orchestrator.threadEvents(lead.threadId), lead.id)[0];
        const { id, ...delivered } = turn?.[0]?._tag === "FromUser" ? turn[0] : { id: undefined };
        assert.isString(id);
        assert.deepStrictEqual(delivered, {
          _tag: "FromUser",
          text: "Check @src/app.ts with $review",
          ...message,
        });
      }

      assert.strictEqual(
        sees.sessions[0]?.sent[0],
        `Check @src/app.ts with $review\n\nAttached files:\n- ${image}\n- ${notes}`,
      );
      const { turnId, ...seen } = sees.sessions[0]?.extras[0] ?? {};
      assert.isString(turnId, "each turn goes with its id");
      assert.deepStrictEqual(seen, {
        images: [{ path: image, mediaType: "image/png", data: "iVBORw==" }],
        skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      });
      // A harness that takes no images still gets their paths, and the skills.
      const { turnId: _blindTurn, ...blinded } = blind.sessions[0]?.extras[0] ?? {};
      assert.deepStrictEqual(blinded, {
        skills: [{ name: "review", path: "/skills/review/SKILL.md" }],
      });
      assert.include(sees.sessions[0]?.options.appendSystemPrompt ?? "", "`$name` names a skill");
      assert.include(sees.sessions[0]?.options.appendSystemPrompt ?? "", "```artifact");
    }).pipe(Effect.provide(testLayer([sees.adapter, blind.adapter])), Effect.scoped);
  });

  it.live("takes the user's message at once, while the session starts and while a turn runs", () => {
    const fake = makeFakeAdapter("claude", {
      startDuration: Duration.millis(150),
      turnDuration: Duration.millis(100),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      assert.lengthOf(fake.sessions, 0, "the thread doesn't wait for its session");

      yield* orchestrator.sendUserMessage(lead.id, "first");
      const queued = (yield* orchestrator.threadEvents(thread.id)).flatMap((event) =>
        event.payload._tag === "MessageQueued" ? [event.payload.message] : [],
      );
      assert.strictEqual(queued[0]?.text, "first", "recorded before the session started");

      yield* waitFor((events) =>
        events.find(
          (event) => event.payload._tag === "AgentStateChanged" && event.payload.state === "running",
        ),
      );
      yield* orchestrator.sendUserMessage(lead.id, "second");
      const second = yield* waitFor((events) =>
        events.find(
          (event) => event.payload._tag === "MessageQueued" && event.payload.message.text === "second",
        ),
      );
      assert.isUndefined(
        (yield* orchestrator.threadEvents(thread.id)).find((event) => event.payload._tag === "TurnCompleted"),
        "recorded while the first turn still runs",
      );

      const turns = yield* waitFor((events) => {
        const inputs = turnInputs(events, lead.id);
        return inputs.length === 2 ? inputs : undefined;
      });
      assert.deepStrictEqual(fake.sessions[0]?.sent, ["first", "second"]);
      const delivered = turns[1]?.[0];
      assert.strictEqual(
        delivered?._tag === "FromUser" ? delivered.id : undefined,
        second.payload._tag === "MessageQueued" ? second.payload.message.id : "",
        "a turn names the queued messages it delivers",
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("keeps the messages of a lead that failed to start, and sends them when it starts", () => {
    const fake = makeFakeAdapter("claude", { startDuration: Duration.millis(50), failedStarts: 1 });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      yield* orchestrator.sendUserMessage(lead.id, "hello");

      const error = yield* waitFor((events) => events.find((event) => event.payload._tag === "AgentError"));
      assert.include(error.payload._tag === "AgentError" ? error.payload.message : "", "Not logged in");
      yield* waitFor((events) =>
        events.find(
          (event) => event.payload._tag === "AgentStateChanged" && event.payload.state === "failed",
        ),
      );

      // With no session to resume, the next message starts a new one and brings the first along.
      yield* orchestrator.sendUserMessage(lead.id, "again");
      const [items] = yield* waitFor((events) => {
        const inputs = turnInputs(events, lead.id);
        return inputs.length > 0 ? inputs : undefined;
      });
      assert.deepStrictEqual(
        items?.map((item) => (item._tag === "FromUser" ? item.text : item._tag)),
        ["hello", "again"],
      );
      assert.isUndefined(fake.sessions[0]?.options.resume);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("refuses an empty message", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startWorkThread;
      const refused = yield* Effect.flip(orchestrator.sendUserMessage(lead.id, "  "));
      assert.strictEqual(refused.reason, "invalid");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("resumes a stopped lead's harness session on the user's next message", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "go" });
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);
      yield* waitFor((events) =>
        events.find((event) => event.agentId === lead.id && event.payload._tag === "TurnCompleted"),
      );
      yield* orchestrator.killChild(lead.id, childId);
      yield* orchestrator.stopAgent(lead.id);

      const refused = yield* Effect.flip(orchestrator.sendUserMessage(childId, "back?"));
      assert.strictEqual(refused.reason, "notAllowed", "only leads resume");

      yield* Effect.all(
        [
          orchestrator.sendUserMessage(lead.id, "still there?"),
          orchestrator.sendUserMessage(lead.id, "hello?"),
        ],
        { concurrency: "unbounded" },
      );
      const items = yield* waitFor((events) =>
        turnInputs(events, lead.id).find((turn) => turn.some((item) => item._tag === "FromUser")),
      );
      // Counted once a turn has run: sessions start in the background.
      const resumed = fake.sessions.filter((session) => session.options.resume === "fake-1");
      assert.strictEqual(resumed.length, 1, "concurrent messages share one resumed session");
      const notice = items.find((item) => item._tag === "SystemNotice");
      assert.include(notice?._tag === "SystemNotice" ? notice.text : "", childId);
      yield* waitFor((events) => {
        const turns = events.filter(
          (event) => event.agentId === lead.id && event.payload._tag === "TurnCompleted",
        );
        return turns.length >= 2 ? turns : undefined;
      });
      assert.strictEqual((yield* orchestrator.agent(lead.id)).providerSessionId, "fake-1");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });

  it.live("spawns catalog children with narrowed access and delivers their result to the lead", () => {
    const fake = makeFakeAdapter("claude", {
      reply: (text, session) => (session.model === "haiku" ? "Paris" : `lead saw: ${text}`),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      const outcome = yield* orchestrator.spawn(lead.id, {
        role: "scout",
        model: "scout",
        access: "acceptEdits",
        prompt: "Capital of France?",
      });
      assert.strictEqual(outcome._tag, "Spawned");
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);

      const child = yield* orchestrator.agent(childId);
      assert.strictEqual(child.access, "ask", "a child never gets more access than its lead");
      assert.strictEqual(child.effort, "low");
      assert.strictEqual(child.parentId, lead.id);

      const [items] = yield* waitFor((events) => {
        const inputs = turnInputs(events, lead.id);
        return inputs.length > 0 ? inputs : undefined;
      });
      assert.deepStrictEqual(items, [
        { _tag: "ChildFinishedTurn", agentId: childId, role: "scout", text: "Paris" },
      ]);
      assert.include(fake.sessions[1]?.sent[0] ?? "", "Capital of France?");
      assert.include(fake.sessions[1]?.options.appendSystemPrompt ?? "", 'role "scout"');
      assert.isTrue(seen.some((event) => event.agentId === lead.id && event.payload._tag === "AgentSpawned"));
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });

  it.live("asks the user before spawning a model outside the catalog", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      const missing = yield* Effect.exit(
        orchestrator.spawn(lead.id, { role: "x", model: "nope", prompt: "?" }),
      );
      assert.isTrue(Exit.isFailure(missing), "unknown models need a provider so the user can decide");

      const outcome = yield* orchestrator.spawn(lead.id, {
        role: "reviewer",
        model: "sonnet",
        provider: "claude",
        access: "fullAccess",
        prompt: "Review",
      });
      assert.strictEqual(outcome._tag, "PendingApproval");
      const requestId = outcome._tag === "PendingApproval" ? outcome.requestId : "";
      const asked = yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "SpawnApprovalRequested"),
      );
      // The user sees what the agent would be told, with the access it would really get.
      assert.deepInclude(asked.payload, { model: "sonnet", access: "ask", prompt: "Review" });
      assert.isTrue(orchestrator.awaitingApproval(lead.threadId), "the thread waits on the user");
      const [overview] = (yield* orchestrator.threadOverviews).filter(
        ({ thread }) => thread.id === lead.threadId,
      );
      assert.isTrue(overview?.awaitingApproval);

      yield* orchestrator.resolveSpawnApproval(requestId, {
        decision: "allow",
        replacement: { provider: "claude", model: "opus" },
      });
      assert.isFalse(orchestrator.awaitingApproval(lead.threadId));
      const spawned = yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "AgentSpawned"),
      );
      assert.deepInclude(spawned.payload, { model: "opus", role: "reviewer" });
      const notice = yield* waitFor((events) =>
        turnInputs(events, lead.id)
          .flat()
          .find((item) => item._tag === "SystemNotice"),
      );
      assert.include(notice._tag === "SystemNotice" ? notice.text : "", "approved");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("lets a lead's unanswered spawn requests lapse when its session ends", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      const outcome = yield* orchestrator.spawn(lead.id, {
        role: "reviewer",
        model: "sonnet",
        provider: "claude",
        prompt: "Review",
      });
      const requestId = outcome._tag === "PendingApproval" ? outcome.requestId : "";

      yield* orchestrator.stopAgent(lead.id);
      assert.isFalse(orchestrator.awaitingApproval(lead.threadId), "a stopped lead waits on nobody");
      yield* orchestrator.sendUserMessage(lead.id, "back?");

      const resolved = yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "SpawnApprovalResolved"),
      );
      assert.deepInclude(resolved.payload, { requestId, decision: "deny" });
      const refused = yield* Effect.flip(orchestrator.resolveSpawnApproval(requestId, { decision: "allow" }));
      assert.strictEqual(refused.reason, "notFound");
      const items = yield* waitFor((events) =>
        turnInputs(events, lead.id).find((turn) => turn.some((item) => item._tag === "FromUser")),
      );
      const notice = items.find((item) => item._tag === "SystemNotice");
      assert.include(notice?._tag === "SystemNotice" ? notice.text : "", 'sonnet as "reviewer"');
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("enforces who may spawn, message and kill", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const first = yield* startWorkThread;
      const second = yield* startWorkThread;
      const spawnScout = (leadId: AgentId) =>
        orchestrator
          .spawn(leadId, { role: "scout", model: "scout", prompt: "go" })
          .pipe(Effect.map((outcome) => (outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId))));
      const child = yield* spawnScout(first.lead.id);
      const otherChild = yield* spawnScout(second.lead.id);

      const reasons = yield* Effect.forEach(
        [
          orchestrator.spawn(child, { role: "x", model: "scout", prompt: "no" }),
          orchestrator.sendMessage(child, second.lead.id, "cross-thread from a child"),
          orchestrator.sendMessage(first.lead.id, otherChild, "into another thread's child"),
          orchestrator.killChild(second.lead.id, child),
        ],
        (attempt) => Effect.flip(attempt).pipe(Effect.map((error) => error.reason)),
      );
      assert.deepStrictEqual(reasons, ["notAllowed", "notAllowed", "notAllowed", "notAllowed"]);

      yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "leads may talk across threads");
      yield* orchestrator.sendMessage(child, first.lead.id, "children may talk to their lead");
      yield* orchestrator.killChild(first.lead.id, child);
      const stopped = (yield* orchestrator.listAgents(first.lead.threadId)).find(
        (agent) => agent.id === child,
      );
      assert.strictEqual(stopped?.state, "stopped");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });

  it.live("starts threads for a lead, whose leads take its brief as the user's request", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      const { thread, lead: started } = yield* orchestrator.startThread(lead.id, {
        prompt: "Add dark mode",
        title: "  Dark mode ",
        access: "fullAccess",
      });
      assert.deepInclude(thread, { title: "Dark mode", mode: "work", cwd: "." });
      assert.deepInclude(started, { provider: "claude", model: "opus", effort: "high", access: "ask" });
      const [brief] = yield* waitFor((events) => turnInputs(events, started.id)[0]);
      const { id: _, ...delivered } = brief?._tag === "FromUser" ? brief : { id: undefined };
      assert.deepStrictEqual(delivered, {
        _tag: "FromUser",
        text: "Add dark mode",
        writtenBy: { agentId: lead.id, threadId: lead.threadId, threadTitle: "Test" },
      });
      const sent = fake.sessions.find((session) => session.sent.some((text) => text.includes("dark mode")));
      assert.include(sent?.sent[0] ?? "", `lead agent ${lead.id} of thread "Test"`);

      const scouting = yield* orchestrator.startThread(lead.id, { prompt: "Scout it", model: "scout" });
      assert.deepInclude(scouting.lead, { model: "haiku", effort: "low" });

      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "go" });
      const child = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);
      const refusals = yield* Effect.forEach(
        [
          orchestrator.startThread(child, { prompt: "a child can't" }),
          orchestrator.startThread(lead.id, { prompt: "x", model: "nope" }),
          orchestrator.startThread(lead.id, { prompt: "x", title: "x".repeat(81) }),
        ],
        (attempt) => Effect.flip(attempt).pipe(Effect.map((error) => error.reason)),
      );
      assert.deepStrictEqual(refusals, ["notAllowed", "invalid", "invalid"]);

      // Refusals spend nothing; the budget counts the threads agents started.
      yield* orchestrator.startThread(lead.id, { prompt: "Third" });
      const spent = yield* Effect.flip(orchestrator.startThread(lead.id, { prompt: "Fourth" }));
      assert.strictEqual(spent.reason, "budgetExceeded");
      assert.lengthOf(yield* orchestrator.listThreads, 4);
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku], threadLimit: 3 })), Effect.scoped);
  });

  it.live("tells a starting lead which threads already work in its folder", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const started = (agentId: AgentId) =>
        waitFor((events) =>
          events.find((event) => event.agentId === agentId && event.payload._tag === "SessionStarted"),
        );
      const first = yield* startWorkThread;
      yield* started(first.lead.id);
      const elsewhere = yield* orchestrator.createThread({
        title: "Elsewhere",
        mode: "work",
        cwd: tmpdir(),
        lead: { provider: "claude", model: "opus", access: "ask" },
      });
      yield* started(elsewhere.lead.id);
      const second = yield* startWorkThread;
      yield* started(second.lead.id);

      const [firstPrompt, elsewherePrompt, secondPrompt] = fake.sessions.map(
        (session) => session.options.appendSystemPrompt ?? "",
      );
      assert.notInclude(firstPrompt, "Other threads in your folder");
      assert.notInclude(elsewherePrompt, "Other threads in your folder");
      assert.include(secondPrompt, `"Test": lead ${first.lead.id} (opus)`);
      assert.notInclude(secondPrompt, elsewhere.lead.id);
      // Every agent is told when a message is worth sending, not just that the tool exists.
      assert.include(firstPrompt, "when you are about to change files another agent is working on");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("ends a turn the harness refuses, so the agent doesn't stay working", () => {
    const fake = makeFakeAdapter("claude");
    const refusing: HarnessAdapter = {
      ...fake.adapter,
      startSession: (options) =>
        fake.adapter.startSession(options).pipe(
          Effect.map((session) => ({
            ...session,
            send: () =>
              Effect.fail(
                new HarnessFailure({
                  provider: "claude",
                  message: "The harness went away.",
                  cause: undefined,
                }),
              ),
          })),
        ),
    };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.agentId === lead.id &&
            event.payload._tag === "AgentStateChanged" &&
            event.payload.state === "idle",
        ),
      );
      const tags = (yield* orchestrator.threadEvents(lead.threadId)).map((event) => event.payload._tag);
      assert.includeMembers(tags, ["TurnInput", "AgentError", "TurnCompleted"]);
      assert.strictEqual((yield* orchestrator.agent(lead.id)).state, "idle");
    }).pipe(Effect.provide(testLayer([refusing])), Effect.scoped);
  });

  it.live("refuses a message to an agent whose session ended, instead of dropping it", () => {
    const fake = makeFakeAdapter("claude", { failedStarts: 1 });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const failed = yield* startWorkThread;
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.agentId === failed.lead.id &&
            event.payload._tag === "AgentStateChanged" &&
            event.payload.state === "failed",
        ),
      );
      const live = yield* startWorkThread;
      const refused = yield* Effect.flip(
        orchestrator.sendMessage(live.lead.id, failed.lead.id, "still there?"),
      );
      assert.strictEqual(refused.reason, "notFound");
      assert.include(refused.message, "isn't running");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("stops a pair of agents from exceeding the message budget", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const first = yield* startWorkThread;
      const second = yield* startWorkThread;
      yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "one");
      yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "two");
      const third = yield* Effect.flip(orchestrator.sendMessage(first.lead.id, second.lead.id, "three"));
      assert.strictEqual(third.reason, "budgetExceeded");
      yield* orchestrator.sendMessage(
        second.lead.id,
        first.lead.id,
        "the reverse direction has its own budget",
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { messageLimit: 2 })), Effect.scoped);
  });

  it.live("starts a messaged thread's turn whatever other threads' turns are waiting on", () => {
    const fake = makeFakeAdapter("claude", { askPermission: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      // More threads than any harness's old turn cap, each turn left waiting on the user.
      const threads = yield* Effect.forEach(Array.from({ length: 8 }), () => startWorkThread);
      const waiting = threads.slice(0, -1);
      yield* Effect.forEach(waiting, ({ lead }) => orchestrator.sendUserMessage(lead.id, "run the tests"));
      yield* waitFor((events) => {
        const asked = events.filter((event) => event.payload._tag === "PermissionRequested");
        return asked.length === waiting.length ? asked : undefined;
      });

      const last = threads.at(-1)!;
      yield* orchestrator.sendMessage(threads[0]!.lead.id, last.lead.id, "are you done?");
      yield* waitFor((events) =>
        events.find(
          (event) => event.agentId === last.lead.id && event.payload._tag === "PermissionRequested",
        ),
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("knows which threads wait on the user and serves their history", () => {
    const fake = makeFakeAdapter("claude", { askPermission: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      assert.isFalse(orchestrator.awaitingApproval(thread.id));

      yield* orchestrator.sendUserMessage(lead.id, "run the tests");
      const request = yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "PermissionRequested"),
      );
      assert.isTrue(orchestrator.awaitingApproval(thread.id));

      const requestId = request.payload._tag === "PermissionRequested" ? request.payload.requestId : "";
      yield* orchestrator.respondToPermission(lead.id, requestId, { decision: "allow", scope: "once" });
      yield* waitFor((events) => events.find((event) => event.payload._tag === "TurnCompleted"));
      assert.isFalse(orchestrator.awaitingApproval(thread.id));

      const history = (yield* orchestrator.threadEvents(thread.id)).map((event) => event.payload._tag);
      assert.includeMembers(history, [
        "TurnInput",
        "PermissionRequested",
        "PermissionResolved",
        "TurnCompleted",
      ]);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("renames threads with a trimmed title and refuses empty or long ones", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread } = yield* startWorkThread;
      const renamed = yield* orchestrator.renameThread(thread.id, "  Fix the login flow  ");
      assert.strictEqual(renamed.title, "Fix the login flow");
      assert.strictEqual(renamed.updatedAt, thread.updatedAt, "renaming isn't activity");
      assert.strictEqual((yield* orchestrator.listThreads)[0]?.title, "Fix the login flow");

      for (const title of ["   ", "x".repeat(81)]) {
        const refused = yield* Effect.flip(orchestrator.renameThread(thread.id, title));
        assert.strictEqual(refused.reason, "invalid");
      }
      const missing = yield* Effect.flip(orchestrator.renameThread("thr_missing" as ThreadId, "Title"));
      assert.strictEqual(missing.reason, "notFound");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("archives and restores threads, but not while they wait on the user", () => {
    const fake = makeFakeAdapter("claude", { askPermission: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      const archived = yield* orchestrator.setThreadArchived(thread.id, true);
      assert.isDefined(archived.archivedAt);
      assert.isDefined((yield* orchestrator.listThreads)[0]?.archivedAt);
      const restored = yield* orchestrator.setThreadArchived(thread.id, false);
      assert.isUndefined(restored.archivedAt);

      yield* orchestrator.sendUserMessage(lead.id, "run the tests");
      yield* waitFor((events) => events.find((event) => event.payload._tag === "PermissionRequested"));
      const refused = yield* Effect.flip(orchestrator.setThreadArchived(thread.id, true));
      assert.strictEqual(refused.reason, "notAllowed");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("puts threads off until later, and archiving one ends its wait", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread } = yield* startWorkThread;
      const later = yield* orchestrator.setThreadLater(thread.id, 1_900_000_000_000);
      assert.strictEqual(later.laterUntil, 1_900_000_000_000);
      assert.strictEqual((yield* orchestrator.listThreads)[0]?.laterUntil, 1_900_000_000_000);
      const back = yield* orchestrator.setThreadLater(thread.id, undefined);
      assert.isUndefined(back.laterUntil);

      yield* orchestrator.setThreadLater(thread.id, 1_900_000_000_000);
      const archived = yield* orchestrator.setThreadArchived(thread.id, true);
      assert.isUndefined(archived.laterUntil);
      const missing = yield* Effect.flip(orchestrator.setThreadLater("thr_missing" as ThreadId, undefined));
      assert.strictEqual(missing.reason, "notFound");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("deletes threads for good, but not while they wait on the user", () => {
    const fake = makeFakeAdapter("claude", { askPermission: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const kept = yield* startWorkThread;
      yield* orchestrator.sendUserMessage(kept.lead.id, "run the tests");
      yield* waitFor((events) => events.find((event) => event.payload._tag === "PermissionRequested"));
      const refused = yield* Effect.flip(orchestrator.deleteThread(kept.thread.id));
      assert.strictEqual(refused.reason, "notAllowed");

      const { thread } = yield* startWorkThread;
      yield* orchestrator.deleteThread(thread.id);
      const ids = (yield* orchestrator.listThreads).map((listed) => listed.id);
      assert.deepStrictEqual(ids, [kept.thread.id]);
      assert.deepStrictEqual(yield* orchestrator.listAgents(thread.id), []);
      const missing = yield* Effect.flip(orchestrator.deleteThread(thread.id));
      assert.strictEqual(missing.reason, "notFound");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("approves read-only agents' requests itself, except the user's MCP tools", () => {
    const web = makeFakeAdapter("claude", { askPermission: true, permissionTool: "WebFetch" });
    const mcp = makeFakeAdapter("codex", { askPermission: true, permissionTool: "mcp__slack__post" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const startChat = (provider: "claude" | "codex") =>
        orchestrator.createThread({
          title: "Research",
          mode: "chat",
          lead: { provider, model: "fake-model", access: "readOnly" },
        });

      const fetching = yield* startChat("claude");
      yield* orchestrator.sendUserMessage(fetching.lead.id, "look it up");
      yield* waitFor((events) =>
        events.find((event) => event.agentId === fetching.lead.id && event.payload._tag === "TurnCompleted"),
      );
      const recorded = (yield* orchestrator.threadEvents(fetching.thread.id)).map(
        (event) => event.payload._tag,
      );
      assert.notInclude(recorded, "PermissionRequested", "nobody was asked, so nothing shows a request");
      assert.notInclude(recorded, "PermissionResolved");

      const posting = yield* startChat("codex");
      yield* orchestrator.sendUserMessage(posting.lead.id, "post it");
      yield* waitFor((events) =>
        events.find(
          (event) => event.agentId === posting.lead.id && event.payload._tag === "PermissionRequested",
        ),
      );
      assert.isTrue(orchestrator.awaitingApproval(posting.thread.id), "MCP tools still ask the user");
    }).pipe(Effect.provide(testLayer([web.adapter, mcp.adapter])), Effect.scoped);
  });

  it.live("hands a child's permission requests to its lead, never the user", () => {
    const leads = makeFakeAdapter("claude");
    const children = makeFakeAdapter("codex", { askPermission: true });
    const coder: CatalogEntry = { alias: "coder", provider: "codex", model: "gpt", description: "Code" };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      const outcome = yield* orchestrator.spawn(lead.id, { role: "coder", model: "coder", prompt: "fix it" });
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);

      const notice = yield* waitFor((events) =>
        turnInputs(events, lead.id)
          .flat()
          .find((item) => item._tag === "SystemNotice" && item.text.includes("answer_permission")),
      );
      const text = notice._tag === "SystemNotice" ? notice.text : "";
      assert.include(text, childId);
      assert.include(text, "requestId p1");
      assert.include(text, "Bash: Run tests");
      assert.isFalse(orchestrator.awaitingApproval(thread.id), "the user isn't asked");

      const other = yield* startWorkThread;
      const stranger = yield* Effect.flip(
        orchestrator.answerChildPermission(other.lead.id, childId, "p1", {
          decision: "allow",
          scope: "once",
        }),
      );
      assert.strictEqual(stranger.reason, "notAllowed");

      yield* orchestrator.answerChildPermission(lead.id, childId, "p1", {
        decision: "deny",
        scope: "once",
        message: "Not now",
      });
      yield* waitFor((events) =>
        turnInputs(events, lead.id)
          .flat()
          .find((item) => item._tag === "ChildFinishedTurn" && item.agentId === childId),
      );
      const again = yield* Effect.flip(
        orchestrator.answerChildPermission(lead.id, childId, "p1", { decision: "allow", scope: "once" }),
      );
      assert.strictEqual(again.reason, "notFound");

      const shown = [...seen, ...(yield* orchestrator.threadEvents(thread.id))].map(
        (event) => event.payload._tag,
      );
      assert.notInclude(shown, "PermissionRequested");
      assert.notInclude(shown, "PermissionResolved");
    }).pipe(
      Effect.provide(testLayer([leads.adapter, children.adapter], { catalog: [coder] })),
      Effect.scoped,
    );
  });

  it.live("denies what a child waits on its lead for once the lead stops", () => {
    const leads = makeFakeAdapter("claude");
    const children = makeFakeAdapter("codex", { askPermission: true });
    const coder: CatalogEntry = { alias: "coder", provider: "codex", model: "gpt", description: "Code" };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      const outcome = yield* orchestrator.spawn(lead.id, { role: "coder", model: "coder", prompt: "fix it" });
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);
      yield* waitFor((events) =>
        turnInputs(events, lead.id)
          .flat()
          .find((item) => item._tag === "SystemNotice" && item.text.includes("answer_permission")),
      );

      yield* orchestrator.stopAgent(lead.id);
      yield* waitFor((events) =>
        events.find((event) => event.agentId === childId && event.payload._tag === "TurnCompleted"),
      );
    }).pipe(
      Effect.provide(testLayer([leads.adapter, children.adapter], { catalog: [coder] })),
      Effect.scoped,
    );
  });

  it.live("tells the lead when the user stops one of its agents", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "go" });
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);

      yield* orchestrator.stopAgent(childId);
      const notice = yield* waitFor((events) =>
        turnInputs(events, lead.id)
          .flat()
          .find((item) => item._tag === "SystemNotice"),
      );
      assert.include(notice._tag === "SystemNotice" ? notice.text : "", childId);
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });

  it.live("keeps chat threads read-only and requires a folder for work threads", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Question",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "acceptEdits" },
      });
      assert.strictEqual(lead.access, "readOnly");
      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "?" });
      const child = yield* orchestrator.agent(outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId));
      assert.strictEqual(child.access, "readOnly");

      const noFolder = yield* Effect.flip(
        orchestrator.createThread({
          title: "Work",
          mode: "work",
          lead: { provider: "claude", model: "opus", access: "ask" },
        }),
      );
      assert.strictEqual(noFolder.reason, "invalid");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });
});
