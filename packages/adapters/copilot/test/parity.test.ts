import { portable, type AgentSession, type PastSession } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, FileSystem, Layer, Stream } from "effect";
import { delimiter, join } from "node:path";
import { expect, it } from "vite-plus/test";

import { CopilotAdapter } from "../src/adapter.ts";
import { fixture, turn, withVariables } from "./support.ts";

const collectUntil = (session: AgentSession, tag: string) =>
  session.events.pipe(
    Stream.map(({ payload }) => payload),
    Stream.takeUntil((payload) => payload._tag === tag),
    Stream.runCollect,
    Effect.forkScoped,
  );

it.skipIf(process.platform === "win32")(
  "uses Copilot's config, history, tasks and compaction RPCs",
  async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-copilot-parity-" });
        const home = join(root, "home");
        const cwd = join(root, "project");
        yield* fs.makeDirectory(home);
        yield* fs.makeDirectory(cwd);
        yield* fs.symlink(fixture, join(root, "copilot"));
        yield* withVariables({
          PATH: [root, process.env["PATH"] ?? ""].join(delimiter),
          COPILOT_HOME: home,
          CERIUM_COPILOT_E2E_TRACE: join(root, "trace.jsonl"),
          CERIUM_COPILOT_E2E_CLI: undefined,
          CERIUM_COPILOT_E2E_LOGOUT: undefined,
        });
        yield* fs.writeFileString(
          join(home, "mcp-config.json"),
          JSON.stringify({
            mcpServers: {
              "docs/~index": {
                type: "http",
                url: "https://example.com/mcp",
                headers: { Authorization: "fixture-only" },
              },
            },
          }),
        );

        const adapter = yield* CopilotAdapter;
        const { hub } = adapter;
        if (
          !hub?.addServer ||
          !hub.setSkill ||
          !hub.setServer ||
          !hub.skillsFolder ||
          !hub.status ||
          !adapter.listSkills ||
          !adapter.listSessions ||
          !adapter.readSession ||
          !adapter.fork ||
          !adapter.sideQuestion
        )
          throw new Error("Missing adapter capability");
        const listing = yield* hub.read(cwd);
        const server = listing.servers[0];
        const skill = listing.skills.find(({ name }) => name === "review");
        if (!server || !skill) throw new Error("Fixture did not load");
        expect(server).toMatchObject({ headers: [{ name: "Authorization", set: true }], scope: "user" });
        expect(JSON.stringify(server)).not.toContain("fixture-only");
        expect(yield* hub.status(cwd)).toEqual([
          {
            name: server.name,
            connection: "connected",
            tools: [{ name: "echo", description: "Echo fixture text" }],
          },
        ]);
        const copy = { ...portable(server), name: "copy" };
        const written = yield* hub.addServer(cwd, "project", copy);
        expect(written).toBe(join(cwd, ".mcp.json"));
        expect(JSON.parse(yield* fs.readFileString(written))).toMatchObject({
          mcpServers: { copy: { headers: { Authorization: "" } } },
        });
        expect((yield* hub.addServer(cwd, "project", copy).pipe(Effect.flip))._tag).toBe("HubConflict");
        expect(yield* hub.addServer(cwd, "user", copy)).toBe(join(home, "mcp-config.json"));
        expect(JSON.parse(yield* fs.readFileString(join(home, "mcp-config.json")))).toMatchObject({
          mcpServers: { copy: { headers: { Authorization: "" } } },
        });
        expect(yield* hub.skillsFolder(cwd, "project")).toBe(join(cwd, ".github", "skills"));
        expect(yield* adapter.listSkills(cwd)).toEqual([
          { name: "review", description: "Review a diff", path: "/work/app/.github/skills/review/SKILL.md" },
        ]);
        yield* hub.setSkill(cwd, skill, false);
        expect(yield* adapter.listSkills(cwd)).toEqual([]);
        yield* hub.setSkill(cwd, skill, true);
        yield* hub.setServer(cwd, server, false);
        expect((yield* hub.read(cwd)).servers.find(({ name }) => name === server.name)?.enabled).toBe(false);
        yield* hub.setServer(cwd, server, true);
        expect((yield* hub.read(cwd)).servers.find(({ name }) => name === server.name)?.enabled).toBe(true);

        const imported = (yield* adapter.listSessions).find(({ id }) => id === "user-session");
        if (!imported) throw new Error("Fixture session was not listed");
        expect(imported).toMatchObject({ cwd: "/work/app", title: "Fix the build" });
        const original = yield* adapter.readSession(imported);
        expect(original.model).toBe("gpt-4.1");
        expect(original.turns.map(({ prompt }) => prompt)).toEqual(["run the tests"]);
        expect(original.turns[0]?.events.map(({ payload }) => payload)).toContainEqual(
          expect.objectContaining({ _tag: "MessageCompleted", text: "All green." }),
        );

        const options = {
          cwd,
          model: "fixture/gpt-4o",
          access: "readOnly",
          mcpServers: {},
          includeUserMcpServers: false,
        } as const;
        const source = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.startSession(options);
            if (!session.stopBackgroundTask || !session.compact)
              throw new Error("Missing session capability");
            const plan = yield* turn(session, "plan", undefined, { turnId: "turn-plan" });
            expect(plan).toContainEqual(
              expect.objectContaining({
                _tag: "TodosUpdated",
                items: [
                  expect.objectContaining({ id: "read", status: "completed" }),
                  expect.objectContaining({ id: "fix", status: "inProgress" }),
                  expect.objectContaining({ id: "ship", status: "pending" }),
                ],
              }),
            );
            expect(yield* turn(session, "background")).toContainEqual(
              expect.objectContaining({
                _tag: "BackgroundTasksChanged",
                tasks: [expect.objectContaining({ id: "shell-1", stoppable: true })],
              }),
            );
            const stopped = yield* collectUntil(session, "BackgroundTasksChanged");
            yield* session.stopBackgroundTask("shell-1");
            expect(yield* Fiber.join(stopped)).toEqual([{ _tag: "BackgroundTasksChanged", tasks: [] }]);
            const compacted = yield* collectUntil(session, "TurnCompleted");
            yield* session.compact;
            expect(yield* Fiber.join(compacted)).toContainEqual(
              expect.objectContaining({
                _tag: "ContextCompacted",
                tokensBefore: 120,
                tokensAfter: 30,
              }),
            );
            yield* turn(session, "Use $review here", undefined, {
              skills: [{ name: "review" }, { name: "missing" }],
            });
            const trace = yield* fs.readFileString(join(root, "trace.jsonl"));
            expect(trace).toContain("Use the review fixture skill.");
            expect(trace).not.toContain('"name":"missing"');
            const started = plan.find((payload) => payload._tag === "SessionStarted");
            if (!started) throw new Error("Copilot did not announce the session");
            return started.providerSessionId;
          }),
        );

        expect((yield* adapter.listSessions).map(({ id }) => id)).toEqual(["user-session"]);
        const copyId = yield* adapter.fork({
          cwd,
          sessionId: source,
          through: { id: "turn-plan", index: 0 },
        });
        const copied: PastSession = { id: copyId, cwd, title: "Fork", updatedAt: 0 };
        expect((yield* adapter.readSession(copied)).turns.map(({ prompt }) => prompt)).toEqual(["plan"]);
        const rewindId = yield* adapter.fork({ cwd, sessionId: source, before: { index: 0 } });
        expect((yield* adapter.readSession({ ...copied, id: rewindId })).turns).toEqual([]);

        const journal = join(home, "fixture-journal.json");
        const sessionsBefore = JSON.parse(yield* fs.readFileString(journal));
        expect(
          yield* adapter.sideQuestion({
            cwd,
            model: options.model,
            sessionId: source,
            instructions: "Answer without changes.",
            prompt: "What happened?",
          }),
        ).toBe("fixture reply");
        expect(JSON.parse(yield* fs.readFileString(journal))).toEqual(sessionsBefore);
      }).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(CopilotAdapter.layer, NodeServices.layer))),
    );
  },
  20_000,
);
