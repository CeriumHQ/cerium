import {
  connect,
  listAcpSessions,
  readAcpSession,
  startAcpSession,
  type AcpCommand,
} from "@cerium/adapter-acp";
import type { AgentSession, SessionOptions } from "@cerium/harness";
import { EventPayload } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { join } from "node:path";
import { antigravityHarness } from "../src/harness.ts";

const command: AcpCommand = {
  provider: "antigravity",
  label: "Antigravity fixture",
  executable: process.execPath,
  args: [join(import.meta.dirname, "fixtures", "fake-agent.mjs")],
};
const options: SessionOptions = {
  cwd: import.meta.dirname,
  model: "gemini-flash",
  access: "ask",
  mcpServers: { cerium: { type: "http", url: "http://127.0.0.1:1/mcp" } },
  trustedMcpServers: ["cerium"],
  includeUserMcpServers: false,
};
const turn = (session: AgentSession, text: string, allow = true) =>
  Effect.gen(function* () {
    yield* session.send(
      text,
      text === "image"
        ? { images: [{ path: "/work/a.png", data: "AA==", mediaType: "image/png" }] }
        : undefined,
    );
    const events = yield* session.events.pipe(
      Stream.tap(({ payload }) =>
        payload._tag === "PermissionRequested"
          ? session.respondToPermission(payload.requestId, {
              decision: allow ? "allow" : "deny",
              scope: "once",
            })
          : Effect.void,
      ),
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runCollect,
    );
    for (const event of events) assert.isTrue(Schema.is(EventPayload)(event.payload));
    return events.map((event) => event.payload);
  });

describe("Antigravity ACP sessions (hand-built fixture)", () => {
  it.live("never silently answers a native choice question, even in full access", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(antigravityHarness, command, {
        ...options,
        access: "fullAccess",
      });
      yield* session.setModel("gemini-pro");
      yield* session.setEffort("max");
      const events = yield* turn(session, "question");
      assert.isTrue(
        events.some((event) => event._tag === "MessageCompleted" && event.text === "Question cancelled"),
      );
      assert.isFalse(events.some((event) => event._tag === "PermissionRequested"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("resets inherited yolo mode, forwards approvals, auto-allows trusted MCP and takes images", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(antigravityHarness, command, options);
      const edit = yield* turn(session, "edit", false);
      assert.isTrue(edit.some((event) => event._tag === "PermissionRequested"));
      assert.isTrue(edit.some((event) => event._tag === "MessageCompleted" && event.text === "Denied"));
      const mcp = yield* turn(session, "mcp");
      assert.isFalse(mcp.some((event) => event._tag === "PermissionRequested"));
      assert.isTrue(mcp.some((event) => event._tag === "MessageCompleted" && event.text === "Allowed"));
      const images = yield* turn(session, "image");
      assert.isTrue(
        images.some((event) => event._tag === "MessageCompleted" && event.text === "Image received"),
      );
      assert.isTrue(images.some((event) => event._tag === "UsageReported" && event.inputTokens === 40));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses edits without a prompt in read-only mode after cold resume", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(antigravityHarness, command, {
        ...options,
        access: "readOnly",
        resume: "agy-session",
      });
      const events = yield* turn(session, "edit");
      assert.isFalse(events.some((event) => event._tag === "PermissionRequested"));
      assert.isTrue(events.some((event) => event._tag === "MessageCompleted" && event.text === "Denied"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("lists native sessions and imports the replayed conversation", () =>
    Effect.gen(function* () {
      const connection = yield* connect(command);
      const sessions = yield* listAcpSessions(connection, "antigravity");
      assert.strictEqual(sessions[0]?.title, "Native history");
      const history = yield* readAcpSession(connection, sessions[0]!, {
        provider: "antigravity",
        cwd: import.meta.dirname,
      });
      assert.strictEqual(history.turns[0]?.prompt, "Remember PELICAN");
      assert.isTrue(
        history.turns[0]!.events.some(
          ({ payload }) => payload._tag === "MessageCompleted" && payload.text === "Remembered PELICAN",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
