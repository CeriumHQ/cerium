import type { AgentSession, SessionOptions } from "@cerium/harness";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeAntigravityAdapter } from "../src/index.ts";

const fixtureBinary = fileURLToPath(new URL("./fixtures/agy.mjs", import.meta.url));

const fixture = (name = "agy-fixture") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-antigravity-test-" });
    const executable = join(cwd, name);
    yield* fs.copyFile(fixtureBinary, executable);
    yield* fs.chmod(executable, 0o700);
    const adapter = yield* makeAntigravityAdapter(executable);
    return { adapter, cwd };
  });

const options = (cwd: string): SessionOptions => ({
  cwd,
  model: "fixture-flash",
  effort: "low",
  access: "ask",
  includeUserMcpServers: true,
  mcpServers: {
    fixture: { type: "http", url: "http://127.0.0.1:9999/mcp", headers: { "X-Fixture": "test" } },
  },
  appendSystemPrompt: "Fixture instructions",
});

const drainTurn = (session: AgentSession) =>
  session.events.pipe(
    Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
  );

describe.skipIf(process.platform === "win32")("Antigravity adapter over ACP", () => {
  it("lists and replays a saved conversation using Antigravity's translator", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter } = yield* fixture();
        const saved = (yield* adapter.listSessions)[0];
        if (saved === undefined) throw new Error("Missing saved session");
        expect(saved).toMatchObject({ id: "acp-fixture", title: "Saved Antigravity" });
        const history = yield* adapter.readSession(saved);
        expect(history.model).toBe("fixture-flash");
        expect(history.turns[0]).toMatchObject({
          prompt: "Review this",
          events: [
            { payload: { _tag: "ToolCallStarted", toolName: "run_command" } },
            { payload: { _tag: "ToolCallCompleted", isError: false } },
            { payload: { _tag: "MessageDelta", text: "Looks good" } },
            { payload: { _tag: "MessageCompleted", text: "Looks good" } },
          ],
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
  it("probes, catalogs, verifies one-call approvals, then resumes with model switching", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        expect(adapter).not.toHaveProperty("usage");
        expect(yield* adapter.probe).toMatchObject({
          _tag: "HarnessInstalled",
          version: "1.5.12",
          auth: { _tag: "LoggedIn" },
        });
        expect(yield* adapter.listModels).toEqual([
          {
            provider: "antigravity",
            id: "fixture-flash",
            label: "Fixture Flash",
            isDefault: true,
            defaultEffort: "high",
            efforts: ["low", "high"],
          },
          { provider: "antigravity", id: "fixture-pro", label: "Fixture Pro", efforts: ["high"] },
        ]);

        const resume = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.startSession(options(cwd));
            const answer = (decision: "allow" | "deny") =>
              session.events.pipe(
                Stream.tap(({ payload }) =>
                  payload._tag === "PermissionRequested"
                    ? session.respondToPermission(payload.requestId, { decision, scope: "session" })
                    : Effect.void,
                ),
                Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
                Stream.runCollect,
                Effect.timeout("10 seconds"),
                Effect.map((events) => events.map(({ payload }) => payload)),
              );
            const image = { path: "/unused/image.png", mediaType: "image/png", data: "eA==" };
            yield* session.send("Run the fixture", {
              images: [image],
            });
            const payloads = yield* answer("deny");
            expect(payloads.map(({ _tag }) => _tag)).toEqual([
              "SessionStarted",
              "ReasoningDelta",
              "ReasoningCompleted",
              "ToolCallStarted",
              "PermissionRequested",
              "PermissionResolved",
              "ToolCallCompleted",
              "ContextReported",
              "MessageDelta",
              "MessageDelta",
              "MessageCompleted",
              "UsageReported",
              "TurnCompleted",
            ]);
            expect(payloads).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", scope: "once", decision: "deny" }),
            );
            expect(payloads).toContainEqual(
              expect.objectContaining({ _tag: "ToolCallCompleted", isError: true }),
            );
            expect(payloads).toContainEqual(
              expect.objectContaining({ _tag: "UsageReported", inputTokens: 30, cachedInputTokens: 2 }),
            );
            expect(payloads).toContainEqual(
              expect.objectContaining({ _tag: "MessageCompleted", text: "Denied." }),
            );
            const started = payloads.find((payload) => payload._tag === "SessionStarted");
            expect(started?.providerSessionId).toBe("acp-fixture");
            if (started === undefined) throw new Error("The session did not start");

            yield* session.send("Allow the fixture", { images: [image] });
            const allowed = yield* answer("allow");
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", scope: "once", decision: "allow" }),
            );
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "ToolCallCompleted", isError: false }),
            );
            return started.providerSessionId;
          }),
        );

        const session = yield* adapter.startSession({ ...options(cwd), resume });
        yield* session.setModel("fixture-pro");
        yield* session.setEffort("high");
        yield* session.send("resume");
        expect((yield* drainTurn(session)).map(({ payload }) => payload)).toContainEqual(
          expect.objectContaining({ _tag: "MessageCompleted", text: "Resumed." }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));

  it("cancels pending permissions and reports a process exit during a turn", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { adapter, cwd } = yield* fixture();
        const session = yield* adapter.startSession(options(cwd));
        yield* session.send("Cancel this fixture", {
          images: [{ path: "/unused/image.png", mediaType: "image/png", data: "eA==" }],
        });
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
        expect((yield* drainTurn(session)).at(-1)?.payload).toEqual({
          _tag: "TurnCompleted",
          stopReason: "error",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));

  it("reports stale and logged-out installs and rejects unsupported access", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const old = yield* fixture("agy-old");
        expect(yield* Effect.flip(old.adapter.listModels)).toMatchObject({ reason: "versionTooOld" });
        const loggedOut = yield* fixture("agy-logged-out");
        expect(yield* loggedOut.adapter.probe).toMatchObject({
          auth: { _tag: "LoggedOut", loginCommand: "agy acp --login" },
        });
        expect(yield* Effect.flip(loggedOut.adapter.listModels)).toMatchObject({ reason: "loggedOut" });

        const { adapter, cwd } = yield* fixture();
        expect(
          yield* Effect.flip(adapter.startSession({ ...options(cwd), access: "readOnly" })),
        ).toMatchObject({
          _tag: "HarnessFailure",
        });
        expect(
          yield* Effect.flip(adapter.startSession({ ...options(cwd), includeUserMcpServers: false })),
        ).toMatchObject({
          _tag: "HarnessFailure",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    ));
});
