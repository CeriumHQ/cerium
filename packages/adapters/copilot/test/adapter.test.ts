import { NodeServices } from "@effect/platform-node";
import type { SessionOptions } from "@cerium/harness";
import { Effect, FileSystem, Layer } from "effect";
import { delimiter, join } from "node:path";
import { expect, it } from "vite-plus/test";

import { CopilotAdapter } from "../src/index.ts";
import { fixture, image, liveCli, startModel, turn, withVariables, type ModelRequest } from "./support.ts";

it.skipIf(process.platform === "win32")(
  "drives Copilot through the installed-executable adapter boundary",
  async () => {
    const calls: Array<ModelRequest> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cerium-copilot-e2e-" });
        const cwd = join(root, "workspace");
        yield* fs.makeDirectory(cwd);
        yield* fs.writeFileString(join(cwd, "AGENTS.md"), "Fixture project instructions");
        yield* fs.symlink(fixture, join(root, "copilot"));
        const modelUrl = liveCli ? yield* startModel(calls) : undefined;
        const trace = process.env["CERIUM_COPILOT_E2E_EVIDENCE"] ?? join(root, "trace.jsonl");
        yield* fs.writeFileString(trace, "");
        const copilotHome = join(root, ".copilot");
        if (modelUrl !== undefined) {
          yield* fs.makeDirectory(copilotHome);
          yield* fs.writeFileString(
            join(copilotHome, "mcp-config.json"),
            JSON.stringify({
              mcpServers: {
                personal: { type: "http", url: modelUrl.replace("/v1", "/mcp"), tools: ["*"] },
              },
            }),
          );
        }
        const variables: Record<string, string | undefined> = {
          PATH: `${root}${delimiter}${process.env["PATH"] ?? ""}`,
          COPILOT_HOME: copilotHome,
          GH_CONFIG_DIR: join(root, ".gh"),
          COPILOT_OFFLINE: "true",
          COPILOT_PROVIDER_BASE_URL: modelUrl,
          COPILOT_MODEL: "gpt-4o",
          COPILOT_ALLOW_ALL: "true",
          COPILOT_GITHUB_TOKEN: undefined,
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          CERIUM_COPILOT_E2E_TRACE: trace,
          CERIUM_COPILOT_E2E_MODEL_URL: modelUrl,
          CERIUM_COPILOT_E2E_LOGOUT: "true",
        };
        yield* withVariables(variables);

        const adapter = yield* CopilotAdapter;
        expect(yield* adapter.probe).toMatchObject({
          _tag: "HarnessInstalled",
          executablePath: join(root, "copilot"),
          auth: { _tag: "LoggedOut", loginCommand: "copilot login" },
        });
        expect(yield* adapter.listModels.pipe(Effect.flip)).toMatchObject({ reason: "loggedOut" });
        delete process.env["CERIUM_COPILOT_E2E_LOGOUT"];
        expect(yield* adapter.listModels).toMatchObject([
          { id: "fixture/gpt-4o", efforts: [] },
          {
            id: "fixture/gpt-4.1",
            efforts: ["low", "high"],
            defaultEffort: "high",
            speeds: ["standard", "fast"],
            defaultSpeed: "standard",
          },
        ]);

        const options: SessionOptions = {
          cwd,
          model: "fixture/gpt-4o",
          access: "ask",
          mcpServers: {
            cerium: { type: "http", url: modelUrl?.replace("/v1", "/mcp") ?? "http://127.0.0.1/mcp" },
          },
          trustedMcpServers: ["cerium"],
          includeUserMcpServers: false,
          appendSystemPrompt: "Fixture appended instructions",
        };
        const sessionId = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* adapter.startSession(options);
            const denied = yield* turn(session, "write denied.txt", "deny");
            expect(denied).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", decision: "deny" }),
            );
            expect(yield* fs.exists(join(cwd, "denied.txt"))).toBe(false);
            const allowed = yield* turn(session, "write allowed.txt", "allow", { turnId: "fixture-turn" });
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "PermissionResolved", decision: "allow" }),
            );
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "FileChanged", change: "created" }),
            );
            expect(allowed).toContainEqual(
              expect.objectContaining({ _tag: "MessageDelta", text: "fixture reply" }),
            );
            expect(allowed.filter(({ _tag }) => _tag === "TurnCompleted")).toEqual([
              { _tag: "TurnCompleted", stopReason: "completed" },
            ]);
            expect(allowed).toContainEqual(
              expect.objectContaining({
                _tag: "UsageReported",
                cachedInputTokens: liveCli ? 8 : 4,
                inputTokens: liveCli ? 40 : 20,
              }),
            );
            expect((yield* fs.readFileString(join(cwd, "allowed.txt"))).trim()).toBe("fixture");
            const bus = yield* turn(session, "ping bus", undefined, { images: [image] });
            if (liveCli) {
              expect(bus).toContainEqual(
                expect.objectContaining({ _tag: "ToolCallStarted", toolName: "mcp__cerium__echo" }),
              );
              expect(bus).toContainEqual(
                expect.objectContaining({
                  _tag: "ToolCallCompleted",
                  isError: false,
                  output: expect.stringContaining("fixture MCP reply"),
                }),
              );
            }
            const interrupted = yield* turn(session, "write interrupted.txt", "interrupt");
            expect(interrupted.at(-1)).toEqual({ _tag: "TurnCompleted", stopReason: "interrupted" });
            expect(yield* fs.exists(join(cwd, "interrupted.txt"))).toBe(false);
            const opened = denied.find(({ _tag }) => _tag === "SessionStarted");
            expect(opened?._tag).toBe("SessionStarted");
            return opened?._tag === "SessionStarted" ? opened.providerSessionId : "";
          }),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const resumed = yield* adapter.startSession({
              ...options,
              resume: sessionId,
              access: "readOnly",
            });
            yield* resumed.setModel("fixture/gpt-4.1");
            if (!liveCli) yield* resumed.setEffort("low");
            if (!liveCli && resumed.setSpeed) yield* resumed.setSpeed("fast");
            const events = yield* turn(resumed, "write read-only.txt");
            expect(events).toContainEqual(
              expect.objectContaining({ _tag: "SessionStarted", providerSessionId: sessionId }),
            );
            expect(events).toContainEqual(
              expect.objectContaining({ _tag: "MessageCompleted", text: "fixture reply" }),
            );
            expect(yield* fs.exists(join(cwd, "read-only.txt"))).toBe(false);
          }),
        );

        if (liveCli) {
          const { hub } = adapter;
          if (!adapter.fork || !adapter.readSession || !adapter.sideQuestion || !hub?.status)
            throw new Error("Missing Copilot capability");
          const forked = yield* adapter.fork({ cwd, sessionId, through: { index: 1, id: "fixture-turn" } });
          const history = yield* adapter.readSession({ cwd, id: forked, title: "Fork", updatedAt: 0 });
          expect(history.turns.map(({ prompt }) => prompt)).toEqual([
            "write denied.txt",
            "write allowed.txt",
          ]);
          expect(
            yield* adapter.sideQuestion({
              cwd,
              sessionId,
              model: options.model,
              instructions: "Answer this question without changes.",
              prompt: "What happened?",
            }),
          ).toBe("fixture reply");
          expect(yield* hub.status(cwd)).toContainEqual(
            expect.objectContaining({
              name: "personal",
              connection: "connected",
            }),
          );
          expect(calls[0]?.tools?.map(({ function: tool }) => tool.name)).not.toContain("personal-echo");
          const readOnly =
            calls
              .findLast(({ messages }) =>
                (JSON.stringify(messages.at(-1)?.content) ?? "").includes("write read-only.txt"),
              )
              ?.tools?.map(({ function: tool }) => tool.name) ?? [];
          expect(readOnly.sort()).toEqual(["cerium-echo", "glob", "grep", "view"]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const withPersonal = yield* adapter.startSession({
                ...options,
                includeUserMcpServers: true,
                access: "acceptEdits",
              });
              yield* turn(withPersonal, "write automatically.txt");
              expect(yield* fs.exists(join(cwd, "automatically.txt"))).toBe(true);
            }),
          );
          expect(calls.at(-1)?.tools?.map(({ function: tool }) => tool.name)).toContain("personal-echo");
        }

        expect(
          yield* adapter.complete({
            cwd,
            model: "fixture/gpt-4o",
            instructions: "Fixture helper prompt",
            prompt: "write helper.txt",
          }),
        ).toBe("fixture reply");
        expect(yield* fs.exists(join(cwd, "helper.txt"))).toBe(false);

        const requests = (yield* fs.readFileString(trace))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "session.send",
            params: expect.objectContaining({ clientTurnId: "fixture-turn" }),
          }),
        );
        // Fast speed runs the model's `-fast` variant.
        if (!liveCli) {
          expect(requests).toContainEqual(
            expect.objectContaining({
              method: "session.model.switchTo",
              params: expect.objectContaining({ modelId: "fixture/gpt-4.1-fast" }),
            }),
          );
        }
        expect(requests).toContainEqual(
          expect.objectContaining({
            method: "session.resume",
            params: expect.objectContaining({
              sessionId,
              continuePendingWork: false,
              tools: expect.objectContaining({
                availableTools: ["builtin:view", "builtin:glob", "builtin:grep", "mcp:*"],
              }),
            }),
          }),
        );
        const helperSession = requests.find(({ method }) => method === "session.delete")?.params?.sessionId;
        expect(helperSession).toEqual(expect.any(String));
        if (liveCli) {
          expect(yield* fs.exists(join(copilotHome, "session-state", helperSession, "events.jsonl"))).toBe(
            false,
          );
          const helper = calls.at(-1);
          expect(helper?.tools ?? []).toEqual([]);
          expect(helper?.messages[0]?.content).toContain("Fixture helper prompt");
          expect(helper?.messages[0]?.content).not.toContain("Fixture project instructions");
          expect(
            calls.flatMap(({ tools }) => tools ?? []).map(({ function: tool }) => tool.name),
          ).not.toContain("task");
          expect(calls.some(({ messages }) => JSON.stringify(messages).includes(image.data))).toBe(true);
          expect(calls[0]?.messages[0]?.content).toContain("Fixture appended instructions");
          expect(calls[0]?.messages[0]?.content).toContain("Fixture project instructions");
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(CopilotAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    );
  },
);
