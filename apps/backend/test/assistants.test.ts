import { Account, type RelayEvent } from "@cerium/account";
import { Orchestrator, UserSettings, type AssistantThreadRequest } from "@cerium/orchestrator";
import {
  defaultSettings,
  type AgentId,
  type AgentInfo,
  type AssistantRequest,
  type DeviceMessage,
  type ProjectInfo,
  type Settings,
  type ThreadId,
  type ThreadInfo,
} from "@cerium/protocol";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, PubSub, SubscriptionRef } from "effect";

import { AssistantCalls, answerAssistant, findProject } from "../src/assistants.ts";
import { Projects } from "../src/project.ts";

const projects: ReadonlyArray<ProjectInfo> = [
  { path: "/code/cerium", usedAt: 3 },
  { path: "/work/cerium", usedAt: 2 },
  { path: "/code/site", usedAt: 1 },
  { path: "/code/gone", usedAt: 0, missing: true },
];

const thread = (id: string, extra: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: id as ThreadId,
  title: "Dark mode",
  mode: "work",
  cwd: "/code/cerium",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const lead: AgentInfo = {
  id: "agt_lead" as AgentId,
  threadId: "thr_1" as ThreadId,
  role: "lead",
  provider: "claude",
  model: "opus",
  access: "ask",
  state: "idle",
  createdAt: 1,
  updatedAt: 1,
};

/** The services an assistant's call reaches, faked, with what was asked of them. */
const fakes = (assistants: Settings["assistants"]) =>
  Effect.gen(function* () {
    const settings = yield* SubscriptionRef.make<Settings>({ ...defaultSettings, assistants });
    const started: Array<AssistantThreadRequest> = [];
    const messages: Array<{ agentId: AgentId; text: string; via?: string }> = [];
    const saved: Array<string> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(UserSettings, {
        get: SubscriptionRef.get(settings),
        changes: SubscriptionRef.changes(settings),
      } as never),
      Layer.succeed(Orchestrator, {
        catalog: Effect.succeed([
          { alias: "scout", provider: "claude", model: "haiku", description: "Quick lookups", priority: 2 },
          { alias: "builder", provider: "claude", model: "opus", description: "Builds things", priority: 1 },
        ]),
        startAssistantThread: (request: AssistantThreadRequest) =>
          Effect.sync(() => {
            started.push(request);
            return { thread: thread("thr_new", { title: request.title ?? "New thread" }), lead };
          }),
        listThreads: Effect.succeed([thread("thr_1"), thread("thr_old", { archivedAt: 5 })]),
        listAgents: () => Effect.succeed([lead]),
        sendUserMessage: (agentId: AgentId, text: string, extras?: { sentVia?: { assistant: string } }) =>
          Effect.sync(() => {
            messages.push({ agentId, text, ...(extras?.sentVia ? { via: extras.sentVia.assistant } : {}) });
          }),
      } as never),
      Layer.succeed(Projects, {
        list: Effect.succeed(projects),
        save: (folder: string) =>
          Effect.sync(() => {
            saved.push(folder);
            return { path: folder, usedAt: 4 };
          }),
      } as never),
    );
    return { layer, settings, started, messages, saved };
  });

const ask = (request: AssistantRequest, layer: Layer.Layer<UserSettings | Orchestrator | Projects>) =>
  answerAssistant("Grok", request).pipe(Effect.provide(layer));

describe("finding a project", () => {
  it("takes its path, or a folder name only one project has", () => {
    expect(findProject(projects, "/code/site/")).toMatchObject({ path: "/code/site" });
    expect(findProject(projects, "Site")).toMatchObject({ path: "/code/site" });
    expect(findProject(projects, "cerium")).toMatch(/Several projects/);
    expect(findProject(projects, "gone")).toMatch(/No project here/);
    expect(findProject(projects, "/elsewhere/secret")).toMatch(/No project here/);
  });
});

describe("answering an assistant", () => {
  it.effect("refuses everything while the user hasn't let assistants in", () =>
    Effect.gen(function* () {
      const { layer, started } = yield* fakes({ enabled: false, access: "ask" });
      const result = yield* ask({ _tag: "StartThread", prompt: "Add dark mode" }, layer);
      assert.strictEqual(result._tag, "Refused");
      assert.include(result._tag === "Refused" ? result.message : "", "Settings → Remote MCP");
      assert.deepStrictEqual(started, []);
    }),
  );

  it.effect("lists the projects that are there, and the models with the default", () =>
    Effect.gen(function* () {
      const { layer } = yield* fakes({ enabled: true, access: "ask" });
      assert.deepStrictEqual(yield* ask({ _tag: "ListProjects" }, layer), {
        _tag: "Projects",
        projects: [
          { path: "/code/cerium", name: "cerium" },
          { path: "/work/cerium", name: "cerium" },
          { path: "/code/site", name: "site" },
        ],
      });
      const models = yield* ask({ _tag: "ListModels" }, layer);
      assert.deepStrictEqual(
        models._tag === "Models" ? models.models.map(({ alias, default: first }) => [alias, first]) : [],
        [
          ["scout", false],
          ["builder", true],
        ],
      );
    }),
  );

  it.effect("starts a thread in the project, with the access the user chose", () =>
    Effect.gen(function* () {
      const { layer, started, saved } = yield* fakes({ enabled: true, access: "acceptEdits" });
      const result = yield* ask(
        { _tag: "StartThread", prompt: "Add dark mode", project: "site", title: "Dark mode", worktree: true },
        layer,
      );
      assert.deepStrictEqual(result, {
        _tag: "ThreadStarted",
        threadId: "thr_new" as ThreadId,
        title: "Dark mode",
      });
      assert.deepStrictEqual(started, [
        {
          assistant: "Grok",
          prompt: "Add dark mode",
          cwd: "/code/site",
          title: "Dark mode",
          worktree: true,
          access: "acceptEdits",
        },
      ]);
      assert.deepStrictEqual(saved, ["/code/site"]);

      const elsewhere = yield* ask({ _tag: "StartThread", prompt: "Read my keys", project: "/etc" }, layer);
      assert.strictEqual(elsewhere._tag, "Refused");
      assert.lengthOf(started, 1);
    }),
  );

  it.effect("sends a thread's lead the message, marked as the assistant's, unless it's archived", () =>
    Effect.gen(function* () {
      const { layer, messages } = yield* fakes({ enabled: true, access: "ask" });
      const sent = yield* ask(
        { _tag: "SendToThread", threadId: "thr_1" as ThreadId, text: "Add tests too" },
        layer,
      );
      assert.deepStrictEqual(sent, { _tag: "Sent" });
      assert.deepStrictEqual(messages, [{ agentId: lead.id, text: "Add tests too", via: "Grok" }]);
      const archived = yield* ask(
        { _tag: "SendToThread", threadId: "thr_old" as ThreadId, text: "Hi" },
        layer,
      );
      const missing = yield* ask(
        { _tag: "SendToThread", threadId: "thr_nope" as ThreadId, text: "Hi" },
        layer,
      );
      assert.deepStrictEqual([archived._tag, missing._tag], ["Refused", "Refused"]);
      assert.lengthOf(messages, 1);
    }),
  );
});

describe("taking assistants' calls", () => {
  it.live("offers this machine while the setting is on, and answers the relay's calls", () =>
    Effect.gen(function* () {
      const { layer, settings } = yield* fakes({ enabled: false, access: "ask" });
      const events = yield* PubSub.unbounded<RelayEvent>();
      const sent: Array<DeviceMessage> = [];
      const offered: Array<boolean> = [];
      const account = Layer.succeed(Account, {
        relayEvents: PubSub.subscribe(events),
        send: (message: DeviceMessage) => Effect.sync(() => void sent.push(message)),
        offerAssistants: (enabled: boolean) => Effect.sync(() => void offered.push(enabled)),
      } as never);
      yield* Layer.build(AssistantCalls.pipe(Layer.provide(Layer.merge(layer, account))));

      yield* SubscriptionRef.update(settings, (current): Settings => ({
        ...current,
        assistants: { enabled: true, access: "ask" },
      }));
      yield* PubSub.publish(events, {
        _tag: "AssistantCall",
        id: "call_12345678",
        assistant: "Grok",
        request: { _tag: "ListProjects" },
      });
      yield* Effect.promise(async () => {
        for (let tries = 0; tries < 100 && sent.length === 0; tries++)
          await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.strictEqual(offered.at(-1), true);
      assert.deepInclude(sent[0], { _tag: "AssistantReply", id: "call_12345678" });
      assert.strictEqual(sent[0]?._tag === "AssistantReply" ? sent[0].result._tag : undefined, "Projects");
    }).pipe(Effect.scoped),
  );
});
