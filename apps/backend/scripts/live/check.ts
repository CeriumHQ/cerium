import type { HarnessAdapter } from "@cerium/harness";
import { AccessMode, ProviderId, type TodoItem } from "@cerium/protocol";
import { Deferred, Duration, Effect, Fiber, Schema, Stream } from "effect";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Live harness checks: one short, real turn per harness in a scratch folder, reported as what the
// harness did (tools, approvals, files, its reply). Every check ends by its deadline, whatever the
// harness does, so nothing waits on a session that never finishes.

/** The default turn: a shell command and a file edit, the two things access modes govern. */
export const PROBE_PROMPT =
  "Do these two steps, without asking me anything:\n" +
  "1. Run this exact shell command with your shell or terminal tool: " +
  "node -e \"require('fs').writeFileSync('shell.txt','ok')\"\n" +
  "2. Create a file named edit.txt containing the text ok, using your file editing tool.\n" +
  "Then reply with just DONE.";
export const PROBE_FILES = ["shell.txt", "edit.txt"];

/** The todo-list turn: a two-item list kept up to date, with a command between its updates. */
export const TODO_PROMPT =
  "Keep a todo list with your todo or plan tool, with exactly two items: 'List the working directory' " +
  "and 'Reply with DONE'. Mark each item in progress when you start it and completed when you finish " +
  "it. Do the first item with one shell command, then reply with just DONE.";
export const TODO_ITEMS = 2;

const Seconds = Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 600 }));

/** The stop turn: long enough to still be running when it is interrupted. */
export const STOP_PROMPT =
  "Run a shell command that just waits 120 seconds (`sleep 120`, or `Start-Sleep 120` in PowerShell), " +
  "with your shell or terminal tool, and wait for it.\nThen reply with just DONE.";

export const LiveCheckRequest = Schema.Struct({
  interruptAfterSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120 })),
  ).annotate({
    description:
      "Interrupt the turn this long after sending it; it passes only if the turn then ends as interrupted, in time.",
  }),
  providers: Schema.optionalKey(Schema.Array(ProviderId)).annotate({
    description: "Harnesses to check, side by side; default every one this machine has.",
  }),
  models: Schema.optionalKey(Schema.Record(Schema.String, Schema.NonEmptyString)).annotate({
    description:
      "A model id per provider, e.g. { claude: 'haiku' }; default each harness's cheapest fast model.",
  }),
  access: Schema.optionalKey(AccessMode).annotate({
    description: "The access each harness runs with; default auto.",
  }),
  prompt: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description:
      "The turn to run. Default: run a shell command that writes shell.txt, edit edit.txt, reply DONE (and expect both files).",
  }),
  expectFiles: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)).annotate({
    description: "Files the turn must leave in its scratch folder to pass.",
  }),
  expectReply: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "Text the final reply must contain to pass.",
  }),
  expectTodos: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description:
      "Fail unless the agent reports a todo list of at least this many items; the prompt must have it keep one.",
  }),
  maxApprovals: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Fail when the harness asks for approval more often than this (0: it must never ask).",
  }),
  approvals: Schema.optionalKey(Schema.Literals(["deny", "allow"])).annotate({
    description: "How approval requests are answered; default deny. Each is recorded either way.",
  }),
  timeoutSeconds: Schema.optionalKey(Seconds).annotate({
    description: "Per harness, start to finish; default 180.",
  }),
  compact: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "After the turn, ask the harness to compact (where its manifest offers it); it passes only if the compaction turn completes and reports ContextCompacted.",
  }),
  trace: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Print each canonical event, with the start of its raw provider message, as it arrives.",
  }),
});
export type LiveCheckRequest = typeof LiveCheckRequest.Type;

export const LiveCheckResult = Schema.Struct({
  provider: ProviderId,
  model: Schema.String,
  access: AccessMode,
  status: Schema.Literals(["passed", "failed", "timedOut", "unavailable"]),
  seconds: Schema.Finite,
  tools: Schema.Array(Schema.String),
  approvals: Schema.Array(
    Schema.Struct({ tool: Schema.String, summary: Schema.String, answer: Schema.String }),
  ),
  files: Schema.Array(Schema.String),
  reply: Schema.optionalKey(Schema.String),
  /** The agent's todo list as its harness last reported it, and how many times it changed. */
  todos: Schema.optionalKey(
    Schema.Struct({
      items: Schema.Array(Schema.Struct({ text: Schema.String, status: Schema.String })),
      updates: Schema.Int,
    }),
  ),
  /** The context as last reported, and how many readings there were. */
  context: Schema.optionalKey(
    Schema.Struct({ tokens: Schema.Int, window: Schema.optionalKey(Schema.Int), readings: Schema.Int }),
  ),
  /** The compactions reported, as `trigger before→after (summary length)`. */
  compactions: Schema.optionalKey(Schema.Array(Schema.String)),
  problems: Schema.Array(Schema.String),
});
export type LiveCheckResult = typeof LiveCheckResult.Type;

/** Cheap, quick models each harness offers, tried before its default. */
const preferred: Partial<Record<ProviderId, RegExp>> = {
  claude: /haiku/i,
  codex: /mini|spark/i,
  cursor: /composer|auto/i,
  // OpenCode Zen's free models run without a provider signed in.
  opencode: /big-pickle|free/i,
  muse: /fast|lite|mini/i,
  grok: /build|fast|mini/i,
};

const listFiles = (folder: string): ReadonlyArray<string> => {
  try {
    return readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(folder.length + 1)
          .replaceAll("\\", "/"),
      )
      .slice(0, 50);
  } catch {
    return [];
  }
};

const describe = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : String(cause);

/** One harness's check. Never fails: whatever goes wrong becomes the result's status and problems. */
export const checkHarness = (
  adapter: HarnessAdapter,
  request: LiveCheckRequest,
): Effect.Effect<LiveCheckResult> =>
  Effect.gen(function* () {
    const access = request.access ?? "auto";
    const prompt = request.prompt ?? PROBE_PROMPT;
    const expectFiles = request.expectFiles ?? (request.prompt === undefined ? PROBE_FILES : []);
    const timeout = Duration.seconds(request.timeoutSeconds ?? 180);
    const started = Date.now();
    const folder = mkdtempSync(join(tmpdir(), `cerium-live-${adapter.provider}-`));
    const record = {
      model: request.models?.[adapter.provider] ?? "",
      tools: [] as Array<string>,
      approvals: [] as Array<{ tool: string; summary: string; answer: string }>,
      reply: undefined as string | undefined,
      todos: undefined as { items: ReadonlyArray<TodoItem>; updates: number } | undefined,
      context: undefined as { tokens: number; window?: number; readings: number } | undefined,
      compactions: [] as Array<string>,
      turns: 0,
      problems: [] as Array<string>,
      stopReason: undefined as string | undefined,
      unavailable: false,
    };

    const run = Effect.gen(function* () {
      if (record.model === "") {
        const models = yield* adapter.listModels;
        const pick =
          models.find((model) => preferred[adapter.provider]?.test(model.id)) ??
          models.find((model) => model.isDefault) ??
          models[0];
        if (pick === undefined) return yield* Effect.fail("The harness offers no models.");
        record.model = pick.id;
      }
      const session = yield* adapter.startSession({
        cwd: folder,
        model: record.model,
        access,
        mcpServers: {},
        includeUserMcpServers: false,
      });
      const done = yield* Deferred.make<void>();
      // Settled by the compaction's turn, when the check asks for one.
      const compacted = yield* Deferred.make<void>();
      const callIds = new Set<string>();
      yield* session.events.pipe(
        Stream.runForEach(({ payload, raw }) =>
          Effect.gen(function* () {
            if (request.trace === true) {
              const rawText = raw === undefined ? "" : JSON.stringify(raw).slice(0, 2000);
              console.error(`[${adapter.provider}] ${JSON.stringify(payload).slice(0, 300)}  <- ${rawText}`);
            }
            switch (payload._tag) {
              case "ContextReported":
                record.context = {
                  tokens: payload.tokens,
                  ...(payload.window === undefined ? {} : { window: payload.window }),
                  readings: (record.context?.readings ?? 0) + 1,
                };
                break;
              case "ContextCompacted":
                record.compactions.push(
                  `${payload.trigger} ${payload.tokensBefore ?? "?"}→${payload.tokensAfter ?? "?"}` +
                    (payload.summary === undefined
                      ? " (no summary)"
                      : ` (summary of ${payload.summary.length} chars)`),
                );
                break;
              case "ToolCallStarted":
                // Some harnesses announce a call again as it progresses.
                if (!callIds.has(payload.callId)) record.tools.push(payload.toolName);
                callIds.add(payload.callId);
                break;
              case "PermissionRequested": {
                const answer = request.approvals ?? "deny";
                record.approvals.push({
                  tool: payload.toolName,
                  summary: payload.summary.slice(0, 200),
                  answer,
                });
                yield* session.respondToPermission(payload.requestId, { decision: answer, scope: "once" });
                break;
              }
              case "MessageCompleted":
                record.reply = payload.text.slice(0, 1_000);
                break;
              case "TodosUpdated":
                record.todos = { items: payload.items, updates: (record.todos?.updates ?? 0) + 1 };
                break;
              case "AgentError":
                record.problems.push(`${payload.kind}: ${payload.message}`);
                break;
              case "AuthRequired":
                record.problems.push(`Signed out: ${payload.reason}`);
                record.unavailable = true;
                yield* Deferred.succeed(done, undefined);
                break;
              case "TurnCompleted":
                record.turns++;
                if (record.turns === 1) {
                  record.stopReason = payload.stopReason;
                  yield* Deferred.succeed(done, undefined);
                } else {
                  if (payload.stopReason !== "completed") {
                    record.problems.push(`The compaction's turn ended: ${payload.stopReason}.`);
                  }
                  yield* Deferred.succeed(compacted, undefined);
                }
                break;
            }
          }),
        ),
        Effect.catch((error) => Effect.sync(() => record.problems.push(describe(error)))),
        Effect.ensuring(
          Effect.andThen(Deferred.succeed(done, undefined), Deferred.succeed(compacted, undefined)),
        ),
        Effect.forkScoped,
      );
      yield* session.send(prompt);
      if (request.interruptAfterSeconds !== undefined) {
        yield* Effect.sleep(Duration.seconds(request.interruptAfterSeconds)).pipe(
          Effect.andThen(session.interrupt),
          Effect.catch((error) => Effect.sync(() => record.problems.push(describe(error)))),
          Effect.forkScoped,
        );
      }
      yield* Deferred.await(done);
      if (request.compact === true) {
        if (session.compact === undefined || adapter.manifest.compact !== true) {
          record.problems.push("The harness can't compact when asked.");
        } else if (!record.unavailable) {
          yield* session.compact;
          yield* Deferred.await(compacted);
          if (record.compactions.length === 0) record.problems.push("No compaction was reported.");
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.sync(() => {
          if (
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            error._tag === "HarnessUnavailable"
          ) {
            record.unavailable = true;
          }
          record.problems.push(describe(error));
        }),
      ),
    );

    // Detached, so a session that won't stop never holds the result back: past the deadline it is
    // interrupted in the background and the check reports what it saw.
    const fiber = yield* Effect.forkDetach(run);
    const finished = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(timeout));
    if (finished._tag === "None") yield* Effect.forkDetach(Fiber.interrupt(fiber));

    const files = listFiles(folder);
    const missing = expectFiles.filter((file) => !files.includes(file));
    const problems = [...record.problems];
    if (finished._tag === "Some") {
      const expectedStop = request.interruptAfterSeconds === undefined ? "completed" : "interrupted";
      if (record.stopReason !== undefined && record.stopReason !== expectedStop) {
        problems.push(`The turn ended: ${record.stopReason} (expected ${expectedStop}).`);
      }
      if (missing.length > 0) problems.push(`Missing ${missing.join(", ")}.`);
      if (request.expectReply !== undefined && !(record.reply ?? "").includes(request.expectReply)) {
        problems.push(`The reply lacks "${request.expectReply}".`);
      }
      if (request.expectTodos !== undefined) {
        if (record.todos === undefined) problems.push("The agent reported no todo list.");
        else if (record.todos.items.length < request.expectTodos) {
          problems.push(
            `The todo list has ${record.todos.items.length} items (expected at least ${request.expectTodos}).`,
          );
        }
      }
      if (request.maxApprovals !== undefined && record.approvals.length > request.maxApprovals) {
        problems.push(
          `Asked for approval ${record.approvals.length} times (allowed ${request.maxApprovals}).`,
        );
      }
    } else {
      problems.push(`No finished turn within ${Duration.toSeconds(timeout)} s.`);
    }
    // The folder's files are reported above; the folder itself is scratch.
    if (finished._tag === "Some") rmSync(folder, { recursive: true, force: true, maxRetries: 3 });

    const result: LiveCheckResult = {
      provider: adapter.provider,
      model: record.model,
      access,
      status:
        finished._tag === "None"
          ? "timedOut"
          : record.unavailable
            ? "unavailable"
            : problems.length === 0
              ? "passed"
              : "failed",
      seconds: Math.round((Date.now() - started) / 100) / 10,
      tools: record.tools,
      approvals: record.approvals,
      files,
      ...(record.reply === undefined ? {} : { reply: record.reply }),
      ...(record.todos === undefined
        ? {}
        : {
            todos: {
              items: record.todos.items.map(({ text, status }) => ({ text, status })),
              updates: record.todos.updates,
            },
          }),
      ...(record.context === undefined ? {} : { context: record.context }),
      ...(record.compactions.length === 0 ? {} : { compactions: record.compactions }),
      problems,
    };
    return result;
  });

/** Checks each requested harness side by side, in the order asked. */
export const runLiveChecks = (
  adapters: ReadonlyMap<ProviderId, HarnessAdapter>,
  request: LiveCheckRequest,
): Effect.Effect<ReadonlyArray<LiveCheckResult>> =>
  Effect.forEach(
    (request.providers ?? [...adapters.keys()]).flatMap((provider) => {
      const adapter = adapters.get(provider);
      return adapter === undefined ? [] : [adapter];
    }),
    (adapter) => checkHarness(adapter, request),
    { concurrency: "unbounded" },
  );

const mark = { passed: "PASS", failed: "FAIL", timedOut: "TIMEOUT", unavailable: "UNAVAILABLE" } as const;

/** A few lines per harness, for an agent or a terminal. */
export const renderResults = (results: ReadonlyArray<LiveCheckResult>): string =>
  results
    .map((result) => {
      const lines = [
        `${mark[result.status]} ${result.provider} (${result.model || "no model"}, ${result.access}) in ${result.seconds} s`,
      ];
      lines.push(`  tools: ${result.tools.length === 0 ? "none" : result.tools.join(", ")}`);
      lines.push(
        `  approvals: ${
          result.approvals.length === 0
            ? "none asked"
            : result.approvals
                .map((approval) => `${approval.tool} (${approval.answer}): ${approval.summary}`)
                .join("; ")
        }`,
      );
      lines.push(`  files: ${result.files.length === 0 ? "none" : result.files.join(", ")}`);
      if (result.todos !== undefined) {
        const { items, updates } = result.todos;
        const listed = items.map((item) => `${item.status}: ${item.text}`).join("; ") || "emptied";
        lines.push(`  todos: ${listed} (${updates} ${updates === 1 ? "update" : "updates"})`);
      }
      if (result.context !== undefined) {
        const { tokens, window, readings } = result.context;
        lines.push(`  context: ${tokens} of ${window ?? "an unreported window"} (${readings} readings)`);
      }
      for (const compaction of result.compactions ?? []) lines.push(`  compacted: ${compaction}`);
      if (result.reply !== undefined)
        lines.push(`  reply: ${result.reply.replace(/\s+/g, " ").slice(0, 300)}`);
      for (const problem of result.problems) lines.push(`  problem: ${problem}`);
      return lines.join("\n");
    })
    .join("\n");
