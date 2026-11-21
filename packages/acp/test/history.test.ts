import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AcpTranslator, listAcpSessions, readAcpSession } from "../src/index.ts";
import { fixture, run } from "./support.ts";

const saved = { id: "fixture-session", cwd: "/project", title: "Fixture", updatedAt: 0 };
const translator = () => new AcpTranslator({ provider: "devin" });

describe("ACP history", () => {
  it("paginates, deduplicates, skips malformed rows and sorts newest first", () =>
    run(
      Effect.gen(function* () {
        const { acp, received } = yield* fixture();
        expect(yield* listAcpSessions(acp)).toEqual([
          { id: "new", title: "New", cwd: "/project", updatedAt: Date.parse("2026-10-02") },
          {
            id: "fixture-session",
            title: "Fixture session fixture-session",
            cwd: "/project",
            updatedAt: Date.parse("2026-10-01"),
          },
        ]);
        const methods = (yield* received).filter(({ method }) => method === "session/list");
        expect(methods.map(({ params }) => params)).toEqual([{}, { cursor: "second" }]);
      }),
    ));

  it("loads replay without prompting or granting agent requests", () =>
    run(
      Effect.gen(function* () {
        const { acp, received } = yield* fixture();
        const history = yield* readAcpSession(acp, saved, translator());
        expect(history.model).toBe("fixture-a");
        expect(history.turns.map(({ prompt }) => prompt)).toEqual(["First prompt", "Second prompt"]);
        expect(history.turns[0]?.events.map(({ payload }) => payload._tag)).toEqual([
          "ReasoningDelta",
          "ReasoningCompleted",
          "ToolCallStarted",
          "ToolCallCompleted",
          "MessageDelta",
          "MessageCompleted",
        ]);
        expect(history.turns[1]?.events.at(-1)?.payload).toMatchObject({
          _tag: "MessageCompleted",
          text: "Second reply",
        });
        const calls = yield* received;
        expect(calls.find(({ method }) => method === "session/load")?.params).toEqual({
          sessionId: saved.id,
          cwd: saved.cwd,
          mcpServers: [],
        });
        expect(calls.some(({ method }) => method === "session/prompt")).toBe(false);
        expect(calls.find(({ id }) => id === "client-1")).toHaveProperty("error.code", -32601);
      }),
    ));

  it("rejects repeated cursors, handles absent capabilities and maps authentication failures", () =>
    run(
      Effect.gen(function* () {
        const repeat = yield* fixture({ ACP_FIXTURE_REPEAT_CURSOR: "1" });
        expect((yield* Effect.flip(listAcpSessions(repeat.acp))).message).toContain("repeated");
        const old = yield* fixture({ ACP_FIXTURE_NO_HISTORY: "1" });
        expect((yield* Effect.flip(listAcpSessions(old.acp))).message).toContain("cannot list");
        expect((yield* Effect.flip(readAcpSession(old.acp, saved, translator()))).message).toContain(
          "cannot replay",
        );
        const loggedOut = yield* fixture({ ACP_FIXTURE_LOGGED_OUT: "1" });
        expect(yield* Effect.flip(readAcpSession(loggedOut.acp, saved, translator()))).toMatchObject({
          _tag: "HarnessUnavailable",
          reason: "loggedOut",
        });
      }),
    ));
});
