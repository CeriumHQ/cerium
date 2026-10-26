import type { HarnessAdapter, PastHistory, PastSession as HarnessSession } from "@cerium/harness";
import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, PastSession } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Adapters,
  Catalog,
  Checkpoints,
  importedEvents,
  Orchestrator,
  OrchestratorConfig,
  SessionImports,
  UserSettings,
  Worktrees,
} from "../src/index.ts";
import { fakeBus, testStore } from "./fakes.ts";
import { ProjectScripts } from "../src/scripts.ts";

const project = process.cwd();
const DAY = 86_400_000;

const listed: ReadonlyArray<HarnessSession> = [
  {
    id: "s-new",
    cwd: project,
    title: "Fix the parser",
    createdAt: 1_000,
    updatedAt: 10 * DAY,
    model: "gpt-x",
  },
  { id: "s-old", cwd: project, title: "Old work", updatedAt: 2 * DAY },
  { id: "s-temp", cwd: join(tmpdir(), "probe"), title: "A probe", updatedAt: 9 * DAY },
  { id: "s-gone", cwd: join(project, "no-such-folder"), title: "Moved away", updatedAt: 8 * DAY },
];

const history: PastHistory = {
  model: "gpt-y",
  turns: [
    {
      prompt: "fix it",
      at: 2_000,
      events: [
        { payload: { _tag: "ReasoningCompleted", messageId: "r1", text: "Looking." } },
        { payload: { _tag: "ToolCallStarted", callId: "t1", toolName: "exec_command", input: {} } },
        { payload: { _tag: "PermissionRequested", requestId: "p1", toolName: "x", summary: "", input: {} } },
        { payload: { _tag: "MessageCompleted", messageId: "m1", text: "Fixed." } },
      ],
    },
    {
      prompt: "thanks",
      events: [
        { payload: { _tag: "MessageCompleted", messageId: "m2", text: "Welcome." } },
        { payload: { _tag: "TurnCompleted", stopReason: "interrupted" } },
      ],
    },
  ],
};

const withSessions = (
  adapter: HarnessAdapter,
  read: ((session: HarnessSession) => PastHistory) | undefined,
): HarnessAdapter => ({
  ...adapter,
  listSessions: Effect.succeed(listed),
  ...(read === undefined ? {} : { readSession: (session: HarnessSession) => Effect.succeed(read(session)) }),
});

const importLayer = (adapters: ReadonlyArray<HarnessAdapter>) =>
  Layer.mergeAll(Orchestrator.layer, SessionImports.layer).pipe(
    Layer.provideMerge(UserSettings.layer),
    Layer.provideMerge(testStore()),
    Layer.provide(Adapters.fromList(adapters)),
    Layer.provide(Layer.succeed(Catalog, { entries: Effect.succeed([]) })),
    Layer.provide(fakeBus),
    Layer.provide(Worktrees.unavailable),
    Layer.provide(Checkpoints.unavailable),
    Layer.provide(ProjectScripts.unavailable),
    Layer.provide(
      OrchestratorConfig.layer({
        chatDirectory: mkdtempSync(join(tmpdir(), "cerium-chat-")),
        batchWindow: Duration.millis(20),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const tags = (events: ReadonlyArray<AgentEvent>) => events.map((event) => event.payload._tag);

describe("importedEvents", () => {
  const session: PastSession = { provider: "codex", id: "s", title: "t", createdAt: 1_000, updatedAt: 9_000 };
  const ids = (turn: number) => `msg_${turn}`;

  it("records the import and the session's start, then each turn with only the conversation's events", () => {
    const events = importedEvents(session, "gpt-y", history, ids);
    assert.deepStrictEqual(
      events.map(({ payload }) => payload._tag),
      [
        "SessionImported",
        "SessionStarted",
        "TurnInput",
        "ReasoningCompleted",
        "ToolCallStarted",
        "MessageCompleted",
        // The call that never finished closes, and the turn ends.
        "ToolCallCompleted",
        "TurnCompleted",
        "TurnInput",
        "MessageCompleted",
        "TurnCompleted",
      ],
    );
    assert.deepInclude(events[1]?.payload, { providerSessionId: "s", model: "gpt-y" });
    assert.deepInclude(events[2]?.payload, { items: [{ _tag: "FromUser", id: "msg_0", text: "fix it" }] });
    assert.deepInclude(events.at(-1)?.payload, { stopReason: "interrupted" });
  });

  it("keeps time moving forward, spreading turns without one over the session's life", () => {
    const times = importedEvents(session, "gpt-y", history, ids).map(({ at }) => at);
    assert.deepStrictEqual(
      times,
      [...times].sort((left, right) => left - right),
    );
    assert.strictEqual(times[2], 2_000);
    // The second turn has no time: halfway through the session.
    assert.strictEqual(times[8], 5_000);
  });

  it("says why when the harness gave no history, and still starts the session", () => {
    const events = importedEvents(session, "gpt-y", { unavailable: "No listing." }, ids);
    assert.deepStrictEqual(
      events.map(({ payload }) => payload),
      [
        { _tag: "SessionImported", provider: "codex", history: "unavailable", detail: "No listing." },
        { _tag: "SessionStarted", provider: "codex", providerSessionId: "s", model: "gpt-y" },
      ],
    );
  });
});

describe("SessionImports", () => {
  it.live("lists the user's sessions, less throwaway folders and folders that are gone", () =>
    Effect.gen(function* () {
      const imports = yield* SessionImports;
      const sessions = yield* imports.list;
      assert.deepStrictEqual(
        sessions.map((session) => `${session.provider}:${session.id}`),
        ["codex:s-new", "codex:s-old"],
      );
    }).pipe(Effect.provide(importLayer([withSessions(makeFakeAdapter("codex").adapter, () => history)]))),
  );

  it.live("brings a session in as a stopped lead on it, once, and resumes it on the next message", () => {
    const fake = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const imports = yield* SessionImports;
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const [session] = yield* imports.list;

      const [thread] = yield* imports.importSessions([session!, session!], { access: "acceptEdits" });
      assert.strictEqual(thread?.title, "Fix the parser");
      assert.strictEqual(thread?.mode, "work");
      assert.strictEqual(thread?.cwd, project);
      assert.strictEqual(thread?.updatedAt, 10 * DAY);
      const [lead] = yield* store.listAgents(thread!.id);
      assert.deepInclude(lead, {
        provider: "codex",
        model: "gpt-y",
        access: "acceptEdits",
        state: "stopped",
        providerSessionId: "s-new",
      });
      assert.deepStrictEqual(tags(yield* store.listEvents(lead!.id)).slice(0, 3), [
        "SessionImported",
        "SessionStarted",
        "TurnInput",
      ]);

      // Listed and imported again, it's already here.
      assert.notInclude(
        (yield* imports.list).map((listedSession) => listedSession.id),
        "s-new",
      );
      assert.deepStrictEqual(yield* imports.importSessions([session!], { access: "ask" }), []);
      assert.strictEqual((yield* store.listThreads).length, 1);

      yield* orchestrator.sendUserMessage(lead!.id, "and one more thing");
      yield* Effect.sleep(Duration.millis(100));
      assert.strictEqual(fake.sessions[0]?.options.resume, "s-new");
      assert.strictEqual(fake.sessions[0]?.options.cwd, project);
    }).pipe(Effect.provide(importLayer([withSessions(fake.adapter, () => history)])));
  });

  it.live("archives sessions older than asked, and says when the harness can't give history", () =>
    Effect.gen(function* () {
      const imports = yield* SessionImports;
      const store = yield* Store;
      const sessions = yield* imports.list;
      const threads = yield* imports.importSessions(sessions, { access: "ask", archiveBefore: 5 * DAY });
      const byTitle = new Map(threads.map((thread) => [thread.title, thread]));
      assert.isUndefined(byTitle.get("Fix the parser")?.archivedAt);
      assert.isNumber(byTitle.get("Old work")?.archivedAt);

      const [lead] = yield* store.listAgents(byTitle.get("Old work")!.id);
      assert.deepStrictEqual(
        (yield* store.listEvents(lead!.id)).map((event) => event.payload),
        [
          {
            _tag: "SessionImported",
            provider: "codex",
            history: "unavailable",
            detail: "This harness doesn't give a session's history.",
          },
          { _tag: "SessionStarted", provider: "codex", providerSessionId: "s-old", model: lead!.model },
        ],
      );
    }).pipe(
      Effect.provide(
        importLayer([
          {
            ...withSessions(makeFakeAdapter("codex").adapter, undefined),
            listSessions: Effect.succeed(listed.map((session) => ({ ...session, model: "gpt-x" }))),
          },
        ]),
      ),
    ),
  );
});
