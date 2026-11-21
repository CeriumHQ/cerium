import type { AgentSession, SessionOptions } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeDevinAdapter } from "../src/index.ts";
import { sessionConfig } from "../src/config.ts";
import { DevinTranslator } from "../src/translate.ts";

const fixtureBinary = fileURLToPath(new URL("./fixtures/devin.mjs", import.meta.url));

const userSettings = `{
  // The user's own Devin settings, with comments as Devin allows.
  "version": 1,
  "agent": { "model": "opus" },
  "mcpServers": { "legacy": { "command": "legacy" } },
  "permissions": { "allow": ["Exec(git)", "mcp__github__issue"], "deny": ["Exec(sudo)"], "ask": ["Write(.env*)"] },
}`;

const fixture = (name = "devin") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-devin-test-" });
    const executable = join(cwd, name);
    yield* fs.copyFile(fixtureBinary, executable);
    yield* fs.chmod(executable, 0o700);
    const settings = join(cwd, "user-config.json");
    yield* fs.writeFileString(settings, userSettings);
    const adapter = yield* makeDevinAdapter(executable, settings);
    return { adapter, cwd, fs };
  });

const options = (cwd: string): SessionOptions => ({
  cwd,
  model: "fixture-swe",
  effort: "max",
  speed: "fast",
  access: "ask",
  includeUserMcpServers: true,
  mcpServers: {
    cerium: { type: "http", url: "http://127.0.0.1:9999/mcp", headers: { Authorization: "Bearer x" } },
  },
  trustedMcpServers: ["cerium"],
  appendSystemPrompt: "Fixture instructions",
});

const turnOf = (session: AgentSession, decision?: "allow" | "deny") =>
  session.events.pipe(
    Stream.tap(({ payload }) =>
      payload._tag === "PermissionRequested" && decision !== undefined
        ? session.respondToPermission(payload.requestId, { decision, scope: "session" })
        : Effect.void,
    ),
    Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
    Effect.map((events) => events.map(({ payload }) => payload)),
  );

describe("Devin session config", () => {
  it("keeps the user's settings but turns off subagents and the grants Cerium's approvals decide", () => {
    const user = {
      version: 1,
      theme: "dark",
      mcpServers: { legacy: {} },
      permissions: {
        allow: ["Exec(git)", "mcp__github__issue"],
        deny: ["Exec(sudo)"],
        ask: ["Write(.env*)"],
      },
    };
    expect(sessionConfig(user, "ask", true)).toEqual({
      version: 1,
      theme: "dark",
      subagents_enabled: false,
      permissions: { allow: [], deny: ["Exec(sudo)"], ask: ["Write(.env*)", "Write(**)"] },
    });
    expect(sessionConfig(user, "acceptEdits", false).permissions).toEqual({
      allow: ["Exec(git)"],
      deny: ["Exec(sudo)"],
      ask: ["Write(.env*)"],
    });
    expect(sessionConfig(undefined, "fullAccess", true)).toEqual({
      version: 1,
      subagents_enabled: false,
      permissions: { allow: [], ask: [] },
    });
  });
});

describe("Devin translator", () => {
  it("reports a write's diff when the tool completes and usage without cache reads", () => {
    const translator = new DevinTranslator();
    translator.update({
      sessionUpdate: "tool_call",
      toolCallId: "w",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }],
      _meta: { "cognition.ai/inferenceToolName": "edit" },
    });
    expect(
      translator.update({ sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed" }),
    ).toEqual([
      { _tag: "ToolCallCompleted", callId: "w", output: null, isError: false },
      { _tag: "FileChanged", path: "/repo/a.ts", change: "modified" },
    ]);
    expect(
      translator.finish({ usage: { inputTokens: 50, outputTokens: 5, cachedReadTokens: 40 } }, "fixture-swe"),
    ).toEqual([
      {
        _tag: "UsageReported",
        provider: "devin",
        model: "fixture-swe",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 40,
      },
    ]);
  });
});

describe.skipIf(process.platform === "win32")("Devin adapter over ACP", () => {
  it("lists invocable skills and imports nonempty conversations with Devin's timestamps", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        expect(yield* adapter.listSkills(cwd)).toEqual([
          { name: "repo:review", description: "Review changes", path: join(cwd, "review", "SKILL.md") },
        ]);
        const sessions = yield* adapter.listSessions;
        expect(sessions).toMatchObject([
          { id: "fixture-1", title: "Saved Devin", createdAt: Date.parse("2026-10-01") },
        ]);
        const saved = sessions[0];
        if (saved === undefined) throw new Error("Missing saved session");
        expect(yield* adapter.readSession(saved)).toMatchObject({
          model: "fixture-swe",
          turns: [
            {
              prompt: "Inspect this",
              at: Date.parse("2026-10-01T00:01:00Z"),
              events: [
                { payload: { _tag: "MessageDelta", text: "From the past." } },
                { payload: { _tag: "MessageCompleted", text: "From the past." } },
              ],
            },
          ],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));

  it("falls back to Devin's local skill folders when the CLI lacks ACP skill listing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd, fs } = yield* fixture("devin-no-skill-list");
        const folder = join(cwd, ".devin", "skills", "local-review");
        yield* fs.makeDirectory(folder, { recursive: true });
        yield* fs.writeFileString(join(folder, "SKILL.md"), "---\nname: local-review\n---\n");
        expect(yield* adapter.listSkills(cwd)).toContainEqual({
          name: "local-review",
          path: join(folder, "SKILL.md"),
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
  it("probes, catalogs every model's efforts, approves once, trusts Cerium's bus, then resumes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd, fs } = yield* fixture();
        expect(yield* adapter.probe).toMatchObject({
          _tag: "HarnessInstalled",
          version: "3000.14.30821",
          auth: { _tag: "LoggedIn" },
        });
        expect(yield* adapter.listModels).toEqual([
          {
            provider: "devin",
            id: "fixture-swe",
            label: "Fixture SWE",
            efforts: ["medium", "high", "max"],
            defaultEffort: "high",
            speeds: ["standard", "fast"],
            defaultSpeed: "standard",
            isDefault: true,
          },
          {
            provider: "devin",
            id: "fixture-opus",
            label: "Fixture Opus",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            defaultEffort: "medium",
          },
        ]);

        const resume = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.startSession(options(cwd));
            const received = JSON.parse(yield* fs.readFileString(join(cwd, "received-config.json")));
            expect(received).toMatchObject({
              agent: { model: "opus" },
              subagents_enabled: false,
              permissions: { allow: [], deny: ["Exec(sudo)"], ask: ["Write(.env*)", "Write(**)"] },
            });
            expect(received.mcpServers).toBeUndefined();
            expect(JSON.parse(yield* fs.readFileString(join(cwd, "received-mcp.json")))).toEqual([
              {
                name: "cerium",
                type: "http",
                url: "http://127.0.0.1:9999/mcp",
                headers: [{ name: "Authorization", value: "Bearer x" }],
              },
            ]);

            yield* session.send("Run the fixture");
            const denied = yield* turnOf(session, "deny");
            expect(denied[0]).toEqual({
              _tag: "SessionStarted",
              provider: "devin",
              providerSessionId: "fixture-1",
              model: "fixture-swe",
              effort: "max",
            });
            const requests = denied.filter((payload) => payload._tag === "PermissionRequested");
            expect(requests).toEqual([
              expect.objectContaining({
                toolName: "exec",
                summary: "Ran exec",
                input: { command: "npm test" },
              }),
            ]);
            expect(denied).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", decision: "deny", scope: "once" }),
            );
            expect(denied).toContainEqual(
              expect.objectContaining({ _tag: "MessageCompleted", text: "reject_once allow_once" }),
            );
            expect(denied).toContainEqual({
              _tag: "FileChanged",
              path: join(cwd, "hello.txt"),
              change: "created",
            });
            expect(denied).toContainEqual({
              _tag: "TodosUpdated",
              items: [{ text: "Test", status: "inProgress" }],
            });
            expect(denied).toContainEqual(
              expect.objectContaining({ _tag: "UsageReported", inputTokens: 20, cachedInputTokens: 100 }),
            );
            expect(denied).toContainEqual({ _tag: "ContextReported", tokens: 900, window: 200000 });
            expect(denied.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });

            yield* session.send("Allow the fixture");
            expect(yield* turnOf(session, "allow")).toContainEqual(
              expect.objectContaining({ _tag: "MessageCompleted", text: "allow_once allow_once" }),
            );
            return "fixture-1";
          }),
        );

        const session = yield* adapter.startSession({ ...options(cwd), resume });
        yield* session.setModel("fixture-opus");
        yield* session.setEffort("minimal");
        expect(yield* Effect.flip(session.setSpeed!("fast"))).toMatchObject({ _tag: "HarnessFailure" });
        yield* session.send("After resuming");
        const resumed = yield* turnOf(session, "allow");
        expect(resumed).not.toContainEqual(expect.objectContaining({ text: "From the past." }));
        expect(resumed.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "completed" });
        expect(
          yield* Effect.flip(
            session.send("Look", { images: [{ path: "/unused.png", mediaType: "image/png", data: "eA==" }] }),
          ),
        ).toMatchObject({ message: "Devin's fixture-opus does not accept images" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));

  it("refuses everything but Cerium's bus when read-only, and cancels approvals on interrupt", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        const readOnly = yield* adapter.startSession({
          ...options(cwd),
          access: "readOnly",
          mcpServers: {
            ...options(cwd).mcpServers,
            other: { type: "stdio", command: "other", args: [] },
          },
        });
        yield* readOnly.send("Read only");
        const payloads = yield* turnOf(readOnly);
        expect(payloads.some(({ _tag }) => _tag === "PermissionRequested")).toBe(false);
        expect(payloads).toContainEqual(
          expect.objectContaining({ _tag: "MessageCompleted", text: "allow_once reject_once" }),
        );

        const session = yield* adapter.startSession(options(cwd));
        yield* session.send("Cancel this fixture");
        const events = yield* session.events.pipe(
          Stream.tap(({ payload }) =>
            payload._tag === "PermissionRequested" ? session.interrupt : Effect.void,
          ),
          Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        expect(events.map(({ payload }) => payload)).toContainEqual(
          expect.objectContaining({ _tag: "PermissionResolved", decision: "deny", scope: "once" }),
        );
        expect(events.at(-1)?.payload).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });

        yield* session.send("exit");
        expect((yield* turnOf(session)).at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "error" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));

  it("reports a logged-out CLI", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture("devin-logged-out");
        expect(yield* adapter.probe).toMatchObject({
          auth: { _tag: "LoggedOut", loginCommand: "devin auth login" },
        });
        expect(yield* Effect.flip(adapter.listModels)).toMatchObject({ reason: "loggedOut" });
        expect(yield* Effect.flip(adapter.startSession(options(cwd)))).toMatchObject({ reason: "loggedOut" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
});
