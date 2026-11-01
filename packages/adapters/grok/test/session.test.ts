import {
  connect,
  listAcpSessions,
  LiveSessions,
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

import { grokHarness, grokOutput, grokToolView } from "../src/harness.ts";

// The Grok session against a real Grok Build session played back (`scripts/record-fixture.ts`): turn 1
// reads, edits, runs a command and calls an injected MCP server; turn 2's write is refused; then the
// session is listed, loaded and compacted.

const fixtures = join(import.meta.dirname, "fixtures");

const replay: AcpCommand = {
  provider: "grok",
  label: "Grok Build",
  executable: process.execPath,
  args: [
    join(import.meta.dirname, "..", "..", "acp", "test", "replay-agent.mjs"),
    join(fixtures, "session.jsonl"),
    join(fixtures, "initialize.json"),
  ],
};

const options: SessionOptions = {
  cwd: import.meta.dirname,
  model: "grok-4.7-build-fast",
  effort: "xhigh",
  access: "ask",
  mcpServers: { smoke: { type: "stdio", command: "node", args: ["echo-mcp.ts"] } },
  includeUserMcpServers: false,
  trustedMcpServers: ["smoke"],
  appendSystemPrompt: "Keep every reply as short as the task allows.",
};

type Tag = EventPayload["_tag"];
type Of<T extends Tag> = Extract<EventPayload, { readonly _tag: T }>;
const all = <T extends Tag>(payloads: ReadonlyArray<EventPayload>, tag: T) =>
  payloads.filter((payload): payload is Of<T> => payload._tag === tag);

/** Sends `text` and gathers the turn, answering each permission request with `answer`. */
const turn = (session: AgentSession, start: Effect.Effect<void, unknown>, answer: "allow" | "deny") =>
  Effect.gen(function* () {
    yield* start;
    const events = yield* session.events.pipe(
      Stream.tap(({ payload }) =>
        payload._tag === "PermissionRequested"
          ? session.respondToPermission(payload.requestId, { decision: answer, scope: "once" })
          : Effect.void,
      ),
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runCollect,
    );
    return Array.from(events, (event) => event.payload);
  });

describe("Grok session", () => {
  it.live("translates a real session's turns, approvals, usage and compaction", () =>
    Effect.gen(function* () {
      const session = yield* startAcpSession(grokHarness(new LiveSessions()), replay, options);
      const first = yield* turn(session, session.send("Read, edit, run and echo."), "allow");
      for (const payload of first) assert.isTrue(Schema.is(EventPayload)(payload), payload._tag);

      const [started] = all(first, "SessionStarted");
      assert.strictEqual(started?.model, "grok-4.7-build-fast");
      assert.strictEqual(started?.effort, "xhigh");

      const calls = all(first, "ToolCallStarted");
      assert.deepStrictEqual(
        calls.map((call) => call.toolName),
        ["Read", "ToolSearch", "Bash", "Edit", "mcp__smoke__echo"],
      );
      assert.deepStrictEqual(calls[0]!.input, { file_path: "/work\\hello.txt" });
      assert.deepInclude(calls[2]!.input as object, { command: "git --version" });
      assert.deepInclude(calls[3]!.input as object, {
        file_path: "/work\\hello.txt",
        old_string: "hello",
        new_string: "goodbye",
      });
      assert.deepStrictEqual(calls[4]!.input, { text: "cerium" });

      // The command and the edit asked; Grok asked for the MCP call too, which the trusted server's
      // call answers without the user.
      assert.deepStrictEqual(
        all(first, "PermissionRequested").map((asked) => asked.toolName),
        ["Bash", "Edit"],
      );
      assert.lengthOf(all(first, "PermissionResolved"), 2);

      const outputs = new Map(all(first, "ToolCallCompleted").map((done) => [done.callId, done]));
      assert.strictEqual(outputs.size, 5);
      assert.strictEqual(outputs.get(calls[0]!.callId)?.output, "1→hello from cerium\n");
      assert.strictEqual(outputs.get(calls[2]!.callId)?.output, "git version 2.56.0.windows.2\n");
      assert.strictEqual(
        outputs.get(calls[3]!.callId)?.output,
        "The file /work\\hello.txt has been updated successfully.",
      );
      assert.strictEqual(outputs.get(calls[4]!.callId)?.output, 'echo:"cerium"');
      assert.isTrue([...outputs.values()].every((done) => !done.isError));
      assert.deepStrictEqual(all(first, "FileChanged"), [
        { _tag: "FileChanged", path: "/work\\hello.txt", change: "modified" },
      ]);

      const messages = all(first, "MessageCompleted").map((message) => message.text);
      assert.strictEqual(messages.at(-1), "DONE");
      assert.deepStrictEqual(all(first, "UsageReported"), [
        {
          _tag: "UsageReported",
          inputTokens: 17655,
          outputTokens: 446,
          cachedInputTokens: 37376,
          costUsd: 0.113348,
        },
      ]);
      assert.deepStrictEqual(all(first, "ContextReported").at(-1), {
        _tag: "ContextReported",
        tokens: 18753,
        window: 256000,
      });
      assert.deepStrictEqual(first.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });

      const second = yield* turn(session, session.send("Create new.txt."), "deny");
      const refused = all(second, "PermissionRequested");
      assert.deepStrictEqual(
        refused.map((asked) => asked.toolName),
        ["Write"],
      );
      assert.deepStrictEqual(all(second, "PermissionResolved"), [
        { _tag: "PermissionResolved", requestId: refused[0]!.requestId, decision: "deny", scope: "once" },
      ]);
      assert.isTrue(all(second, "ToolCallCompleted")[0]?.isError);
      assert.lengthOf(all(second, "FileChanged"), 0);
      assert.deepStrictEqual(all(second, "UsageReported"), [
        {
          _tag: "UsageReported",
          inputTokens: 89,
          outputTokens: 82,
          cachedInputTokens: 18688,
          costUsd: 0.020028,
        },
      ]);
      // Grok ends a turn whose call was refused; that is not Cerium's stop.
      assert.deepStrictEqual(second.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });

      const compacted = yield* turn(session, session.compact!, "deny");
      assert.deepStrictEqual(all(compacted, "ContextCompacted"), [
        { _tag: "ContextCompacted", trigger: "manual", tokensBefore: 18866, tokensAfter: 18866 },
      ]);
      assert.deepStrictEqual(compacted.at(-1), { _tag: "TurnCompleted", stopReason: "completed" });
    }).pipe(Effect.scoped, Effect.timeout("30 seconds"), Effect.provide(NodeServices.layer)),
  );

  it.live("lists the session and reads its turns back", () =>
    Effect.gen(function* () {
      const connection = yield* connect(replay);
      const sessions = yield* listAcpSessions(connection, "grok");
      assert.deepStrictEqual(
        sessions.map((session) => [session.cwd, session.title]),
        [["/work", "Read hello.txt, git version, MCP echo cerium"]],
      );
      const history = yield* readAcpSession(connection, sessions[0]!, {
        provider: "grok",
        cwd: "/work",
        view: grokToolView,
        output: grokOutput,
      });
      assert.lengthOf(history.turns, 2);
      assert.match(history.turns[0]!.prompt, /^Read hello\.txt/);
      const first = history.turns[0]!.events.map((event) => event.payload);
      // A loaded session replays each call once it finished, in the order they did.
      assert.deepStrictEqual(
        all(first, "ToolCallStarted").map((call) => call.toolName),
        ["ToolSearch", "Read", "Bash", "mcp__smoke__echo", "Edit"],
      );
      assert.strictEqual(all(first, "MessageCompleted").at(-1)?.text, "DONE");
      // Live-only events stay out of a past turn.
      assert.lengthOf(all(first, "TurnCompleted"), 0);
      assert.lengthOf(all(first, "MessageDelta"), 0);
      const second = history.turns[1]!.events.map((event) => event.payload);
      assert.isTrue(all(second, "ToolCallCompleted")[0]?.isError);
    }).pipe(Effect.scoped, Effect.timeout("30 seconds"), Effect.provide(NodeServices.layer)),
  );
});
