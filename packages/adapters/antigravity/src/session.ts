import {
  HarnessFailure,
  scratchFolder,
  type AdapterEvent,
  type AgentSession,
  type PermissionDecision,
  type SessionOptions,
} from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import { Cause, Deferred, Duration, Effect, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { grantKey, hookTool, openBridge, verdictFor, type HookAnswer, type HookInput } from "./hook.ts";
import {
  agentFile,
  HOOK_SCRIPT,
  hookCommand,
  hooksConfig,
  mcpConfig,
  PLUGIN_NAME,
  pluginManifest,
  RUN_ENV,
  runArgs,
  userLine,
} from "./launch.ts";
import { AgyTranslator, type AgyEvent, type AgyRecord } from "./translate.ts";

/** How long an interrupted run may take to stop before it is killed. */
const STOP_GRACE = Duration.seconds(5);
const STDERR_LINES = 40;

/** Where Antigravity keeps its configuration: `~/.gemini`. */
export const defaultGeminiHome = () => join(homedir(), ".gemini");

export interface AntigravitySessionOverrides {
  /** Antigravity's configuration folder, whose `config/agents` Cerium's agent goes in (tests). */
  readonly geminiHome?: string;
  /** Sees every stream line (the fixture recorder). */
  readonly record?: (record: AgyRecord) => void;
}

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "antigravity", message, cause });

const write = (path: string, text: string) =>
  Effect.tryPromise({
    try: () => writeFile(path, text, { mode: 0o600 }),
    catch: failure(`Couldn't write ${path}`),
  });

/**
 * Starts a Cerium session on the user's Antigravity CLI. Each `send` is one `agy` run that continues the
 * conversation by id; Cerium's agent and plugin carry its MCP servers, instructions and approval hook.
 * Turns run one at a time in `send` order, each ending in exactly one `TurnCompleted`. Closing the
 * scope stops a running turn and removes the agent and plugin. `events` is single-consumer.
 */
export const startAntigravitySession = Effect.fn("AntigravitySession.start")(function* (
  executablePath: string,
  options: SessionOptions,
  overrides: AntigravitySessionOverrides = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = resolve(options.cwd);
  const id = randomBytes(6).toString("hex");
  const agentName = `cerium-${id}`;
  const servers = Object.keys(options.mcpServers);
  const trusted = options.trustedMcpServers ?? [];

  const events = yield* Queue.unbounded<AdapterEvent, HarnessFailure | Cause.Done>();
  const translator = new AgyTranslator({ mcpServers: servers, plugin: PLUGIN_NAME, cwd });
  const emit = (record: AgyRecord) => {
    overrides.record?.(record);
    Queue.offerAllUnsafe(events, translator.translate(record));
  };

  // Approvals: the hook's calls, answered by the access mode or the user.
  const pending = new Map<string, Deferred.Deferred<PermissionDecision>>();
  const grants = new Set<string>();
  let asked = 0;
  const context = yield* Effect.context<never>();
  const decide = (input: HookInput): Promise<HookAnswer> =>
    Effect.runPromiseWith(context)(
      Effect.gen(function* () {
        const tool = hookTool(input, servers, PLUGIN_NAME);
        const key = grantKey(tool);
        const { verdict, reason } = grants.has(key)
          ? { verdict: "allow" as const, reason: undefined }
          : verdictFor(options.access, tool, { trusted, cwd });
        if (verdict === "allow") return { decision: "auto_approve" } as const;
        if (verdict === "deny") return { decision: "deny", reason: reason ?? "Denied." } as const;
        const requestId = `antigravity:${id}:permission:${++asked}`;
        const answer = yield* Deferred.make<PermissionDecision>();
        pending.set(requestId, answer);
        const summary =
          tool.toolName === "shell" && typeof tool.input["command"] === "string"
            ? `Run ${tool.input["command"]}`
            : tool.path !== undefined
              ? `${tool.native.replace(/_/g, " ")} ${tool.path}`
              : `Use ${tool.toolName}`;
        Queue.offerUnsafe(events, {
          payload: {
            _tag: "PermissionRequested",
            requestId,
            toolName: tool.toolName,
            summary,
            input: tool.input,
          },
          raw: input,
        });
        const given = yield* Deferred.await(answer).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        );
        Queue.offerUnsafe(events, {
          payload: { _tag: "PermissionResolved", requestId, decision: given.decision, scope: given.scope },
          raw: given,
        });
        if (given.decision === "allow") {
          if (given.scope === "session") grants.add(key);
          return { decision: "auto_approve" } as const;
        }
        return { decision: "deny", reason: given.message ?? "The user denied this." } as const;
      }),
    );
  const bridge = yield* openBridge(decide);
  const denyPending = Effect.suspend(() =>
    Effect.forEach(
      [...pending.values()],
      (answer) =>
        Deferred.succeed(answer, { decision: "deny", scope: "once", message: "The turn was stopped." }),
      { discard: true },
    ),
  );

  // The session's agent and plugin.
  const geminiHome = overrides.geminiHome ?? defaultGeminiHome();
  const agents = join(geminiHome, "config", "agents");
  const folder = yield* scratchFolder("antigravity", `session-${id}`);
  const plugin = join(folder, PLUGIN_NAME);
  const agentPath = join(agents, `${agentName}.md`);
  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          Promise.all([mkdir(plugin, { recursive: true, mode: 0o700 }), mkdir(agents, { recursive: true })]),
        catch: failure("Couldn't prepare Cerium's Antigravity agent"),
      });
      const script = join(plugin, "hook.mjs");
      yield* write(join(plugin, "plugin.json"), JSON.stringify(pluginManifest(), null, 2));
      yield* write(join(plugin, "mcp_config.json"), JSON.stringify(mcpConfig(options.mcpServers), null, 2));
      yield* write(join(plugin, "hooks.json"), JSON.stringify(hooksConfig(hookCommand(script)), null, 2));
      yield* write(script, HOOK_SCRIPT);
      yield* write(join(plugin, "bridge.json"), JSON.stringify(bridge));
      yield* write(
        agentPath,
        agentFile({
          name: agentName,
          pluginDirectory: plugin,
          includeUserMcpServers: options.includeUserMcpServers,
          instructions: options.appendSystemPrompt,
        }),
      );
    }),
    () =>
      Effect.promise(() =>
        Promise.all([rm(agentPath, { force: true }), rm(folder, { recursive: true, force: true })]).then(
          () => undefined,
          () => undefined,
        ),
      ),
  );

  let model = options.model;
  let effort: ReasoningEffort | undefined = options.effort;
  emit({ type: "opened", sessionId: options.resume, model, effort });

  /** The run in flight, which `interrupt` signals. */
  let running:
    | {
        readonly kill: (signal: "SIGINT" | "SIGKILL") => Effect.Effect<void>;
        readonly done: Deferred.Deferred<void>;
      }
    | undefined;
  let queued = 0;
  let interruptRequested = false;

  const runTurn = (text: string) =>
    Effect.gen(function* () {
      queued--;
      if (interruptRequested) {
        interruptRequested = false;
        emit({ type: "run" });
        emit({ type: "event", event: { event: "result", result: { status: "CANCELED" } } });
        return;
      }
      emit({ type: "run" });
      const done = yield* Deferred.make<void>();
      const stderr: Array<string> = [];
      yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            executablePath,
            [
              ...runArgs({
                agent: agentName,
                conversation: translator.sessionId,
                model,
                effort,
                access: options.access,
              }),
            ],
            { cwd, extendEnv: true, env: { ...RUN_ENV } },
          ),
        );
        running = {
          kill: (signal) => handle.kill({ killSignal: signal }).pipe(Effect.ignore),
          done,
        };
        const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        Queue.offerUnsafe(input, new TextEncoder().encode(userLine(text)));
        yield* Stream.fromQueue(input).pipe(Stream.run(handle.stdin), Effect.ignore, Effect.forkScoped);
        yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              stderr.push(line);
              if (stderr.length > STDERR_LINES) stderr.shift();
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              if (line.trim() === "") return;
              let event: AgyEvent;
              try {
                event = JSON.parse(line) as AgyEvent;
              } catch {
                return;
              }
              emit({ type: "event", event });
              // One message per run: its result ends the run's input too.
              if (event.event === "result") Queue.endUnsafe(input);
            }),
          ),
          Effect.ignore,
        );
        const code = yield* handle.exitCode.pipe(
          Effect.map((exit): number | undefined => Number(exit)),
          Effect.orElseSucceed(() => undefined),
        );
        emit({ type: "exited", code, stderr: stderr.join("\n") });
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() => emit({ type: "failed", message: `Couldn't run Antigravity: ${error.message}` })),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            running = undefined;
            interruptRequested = false;
            yield* denyPending;
            yield* Deferred.succeed(done, undefined);
          }),
        ),
      );
    });

  const turns = yield* Queue.unbounded<string>();
  yield* Effect.forkScoped(Effect.forever(Queue.take(turns).pipe(Effect.flatMap(runTurn))));

  const sessionScope = yield* Effect.scope;
  const interrupt = Effect.suspend(() => {
    const run = running;
    if (queued > 0) interruptRequested = true;
    if (run === undefined) return Effect.void;
    // Ctrl+C cancels the turn (`finished_reason: "interrupted"`); a run that won't stop is killed.
    return run
      .kill("SIGINT")
      .pipe(
        Effect.andThen(denyPending),
        Effect.andThen(
          Deferred.await(run.done).pipe(
            Effect.timeoutOrElse({ duration: STOP_GRACE, orElse: () => run.kill("SIGKILL") }),
          ),
        ),
        Effect.forkIn(sessionScope),
        Effect.asVoid,
      );
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const run = running;
      if (run !== undefined) {
        yield* run.kill("SIGINT");
        yield* denyPending;
        yield* Deferred.await(run.done).pipe(
          Effect.timeoutOrElse({ duration: STOP_GRACE, orElse: () => run.kill("SIGKILL") }),
        );
      }
      yield* Queue.end(events);
    }),
  );
  return {
    events: Stream.fromQueue(events),
    send: (text) => Effect.sync(() => queued++).pipe(Effect.andThen(Queue.offer(turns, text)), Effect.asVoid),
    respondToPermission: (requestId, decision) =>
      Effect.suspend(() => {
        const answer = pending.get(requestId);
        return answer === undefined ? Effect.void : Deferred.succeed(answer, decision).pipe(Effect.asVoid);
      }),
    interrupt,
    // Both are flags of the next run.
    setModel: (next) => Effect.sync(() => void (model = next)),
    setEffort: (next) => Effect.sync(() => void (effort = next)),
  } satisfies AgentSession;
});
