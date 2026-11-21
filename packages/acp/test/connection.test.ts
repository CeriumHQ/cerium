import { HarnessFailure } from "@cerium/harness";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { AcpError, ErrorCode, connect, needsLogin, type Incoming } from "../src/index.ts";
import { fixture, harness, run } from "./support.ts";

describe("ACP connection", () => {
  it("negotiates version 1, skipping lines that aren't JSON-RPC 2.0, and reads the agent's capabilities", () =>
    run(
      Effect.gen(function* () {
        const { acp, received } = yield* fixture();
        expect(acp.agent).toMatchObject({
          loadSession: true,
          resumeSession: true,
          images: true,
          httpMcp: true,
          authMethods: [{ id: "fixture-login" }],
          meta: { fixture: { client: "test" } },
        });
        const [initialize] = yield* received;
        expect(initialize).toMatchObject({
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientInfo: { name: "cerium", title: "Cerium" },
            clientCapabilities: {},
            _meta: { client: "test" },
          },
        });
      }),
    ));

  it("fails when the agent negotiates another protocol version", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(fixture({ ACP_FIXTURE_PROTOCOL: "2" }));
        expect(error).toMatchObject({
          _tag: "HarnessFailure",
          provider: "devin",
          message: "Fixture did not negotiate ACP version 1",
        });
      }),
    ));

  it("fails clearly when the executable can't start", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          connect(harness, { executable: "/nonexistent/acp-agent", args: [], cwd: "/" }),
        );
        expect(error).toMatchObject({
          _tag: "HarnessFailure",
          message: "Could not start the Fixture ACP agent",
        });
      }),
    ));

  it("pairs each response with its request, however the agent orders them", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const answers = yield* Effect.all(
          [
            acp.query("echo", { value: "slow", delay: 80 }),
            acp.query("echo", { value: "fast", delay: 0 }),
            acp.query("echo", { value: "middle", delay: 30 }),
          ],
          { concurrency: "unbounded" },
        );
        expect(answers).toEqual([{ echo: "slow" }, { echo: "fast" }, { echo: "middle" }]);
      }),
    ));

  it("turns error responses into AcpError, and refusals into the user's HarnessFailure", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const error = yield* Effect.flip(acp.query("fail", { code: -32602, message: "Bad params" }));
        expect(error).toBeInstanceOf(AcpError);
        expect(error).toMatchObject({ code: -32602, message: "Bad params" });
        expect(needsLogin(error)).toBe(false);
        expect(acp.refused("fail")(error)).toMatchObject({
          _tag: "HarnessFailure",
          message: "Fixture refused `fail`: Bad params",
          cause: error,
        });
        expect(yield* Effect.flip(acp.call("fail", { code: 1, message: "No" }))).toMatchObject({
          _tag: "HarnessFailure",
          message: "Fixture refused `fail`: No",
        });

        const login = yield* Effect.flip(
          acp.query("fail", { code: ErrorCode.authRequired, message: "Authentication required" }),
        );
        expect(needsLogin(login)).toBe(true);

        // A failure that is already the harness's own passes through untouched.
        const own = new HarnessFailure({ provider: "devin", message: "Gone", cause: undefined });
        expect(acp.refused("fail")(own)).toBe(own);
      }),
    ));

  it("lets a harness keep only the code of a refusal", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture(
          {},
          {
            refused: (_method, error) =>
              new HarnessFailure({
                provider: "grok",
                message: `Rejected (${error.code})`,
                cause: error.code,
              }),
          },
        );
        expect(yield* Effect.flip(acp.call("fail", { code: 7, message: "secret: token=abc" }))).toEqual(
          new HarnessFailure({ provider: "grok", message: "Rejected (7)", cause: 7 }),
        );
      }),
    ));

  it("times out a query the agent never answers", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        expect(yield* Effect.flip(acp.query("silent", {}, "100 millis"))).toMatchObject({
          _tag: "HarnessFailure",
          message: "Fixture did not respond to `silent`",
        });
      }),
    ));

  it("delivers the agent's notifications and requests, and refuses requests nothing handles", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        // Before a handler is set, requests are refused and notifications dropped.
        expect(yield* acp.query("ask_client", { method: "fs/read_text_file" })).toEqual({
          error: { code: ErrorCode.methodNotFound, message: "Unsupported client method" },
        });

        const seen: Array<Incoming> = [];
        const noted = yield* Deferred.make<void>();
        acp.onMessage((message) =>
          Effect.gen(function* () {
            seen.push(message);
            if (message.id !== undefined) return yield* acp.respond(message.id, { handled: message.method });
            yield* Deferred.succeed(noted, undefined);
          }),
        );
        yield* acp.query("notify_client", {});
        yield* Deferred.await(noted);
        expect(yield* acp.query("ask_client", { method: "fixture/question" })).toEqual({
          handled: "fixture/question",
        });
        expect(seen).toEqual([
          { method: "fixture/note", params: { n: 1 } },
          { method: "fixture/question", params: {}, id: "client-2" },
        ]);
      }),
    ));

  it("fails requests in flight when the agent exits, and every request after", () =>
    run(
      Effect.gen(function* () {
        const { acp } = yield* fixture();
        const pending = yield* acp.request("silent", {}).pipe(Effect.forkChild);
        expect(acp.isClosed()).toBe(false);
        yield* acp.notify("exit", {});
        const exited = yield* acp.exited;
        expect(exited).toMatchObject({ _tag: "HarnessFailure", message: "The Fixture ACP process exited" });
        expect(acp.isClosed()).toBe(true);
        expect(yield* Effect.flip(Fiber.join(pending))).toBe(exited);
        expect(yield* Effect.flip(acp.request("echo", { value: 1 }))).toBe(exited);
        // Writing to a closed connection is a no-op rather than a defect.
        yield* acp.notify("anything", {});
      }),
    ));
});
