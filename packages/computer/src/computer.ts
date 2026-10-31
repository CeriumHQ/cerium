import type { AgentId, ComputerUseSession, ComputerUseStatus, ThreadId } from "@cerium/protocol";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";

import { guideFor, type GuideTopic } from "./guide.ts";
import {
  batchErrorCodes,
  batchText,
  capped,
  errorCode,
  parseEnvelope,
  refusal,
  screenshotArgs,
  type Envelope,
  type Step,
} from "./policy.ts";
import { fitPng } from "./png.ts";
import { AGENT_DESKTOP_VERSION, CONTRACT_MAJOR, releaseFor } from "./release.ts";

// Computer use: agents of every harness see and operate the user's desktop through agent-desktop
// (github.com/vercel-labs/agent-desktop), which reads apps through the operating system's
// accessibility tree. This service keeps the program installed, runs agents' commands in an
// agent-desktop session per thread (each agent gets a labelled cursor on screen), and knows who is
// using the computer, so the user can see it and stop them.

export class ComputerError extends Schema.TaggedError<ComputerError>()("ComputerError", {
  reason: Schema.Literals(["unsupported", "install", "run", "stopped"]),
  message: Schema.String,
}) {}

/** The agent making a call: whose cursor it moves, and what that cursor says. */
export interface Caller {
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly label: string;
}

/** What a call answers the agent. */
export interface Answer {
  readonly text: string;
  /** A screenshot, as base64 PNG. */
  readonly image?: string;
  /** Every step succeeded. */
  readonly ok: boolean;
  /** The failed steps' error codes, such as `POLICY_DENIED`. */
  readonly codes: ReadonlyArray<string>;
}

export interface ComputerOptions {
  /** Where agent-desktop's builds are kept, a folder per version. */
  readonly toolsDirectory: string;
  /** agent-desktop's own state (sessions, snapshots); it creates the folder private to the user. */
  readonly stateDirectory: string;
}

/** A screenshot's longest side once shrunk for a model; Claude's own limit before it shrinks one. */
const SCREENSHOT_EDGE = 1568;

/** How long an agent counts as using the computer after its last call. */
const IDLE = Duration.minutes(3);

/** The longest one call may take, its own waits included. */
const CALL_TIMEOUT = Duration.minutes(2);

const BATCH_BUDGET_MS = 90_000;

/**
 * What this backend names its sessions: its process, so a backend that starts after another one
 * stopped without ending its own (a crash) can tell those apart from a running one's and end them.
 */
const SESSION_NAME = `Cerium ${process.pid}`;

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not ours to signal, but there.
    return (error as { readonly code?: string }).code === "EPERM";
  }
};

/** agent-desktop's names (sessions, agents) are 1 to 64 letters, digits, `-` and `_`. */
const agentDesktopName = (value: string) => value.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "agent";

interface AgentUse {
  readonly label: string;
  readonly startedAt: number;
  lastAt: number;
  busy: number;
}

interface ThreadUse {
  /** agent-desktop's session, once started. */
  session?: string;
  readonly agents: Map<AgentId, AgentUse>;
  /** Settles when the user stops this thread's agents, ending the calls under way. */
  stopped: Deferred.Deferred<void>;
}

export class Computer extends Context.Service<
  Computer,
  {
    readonly status: Effect.Effect<ComputerUseStatus>;
    /** The status now and after every change. */
    readonly changes: Stream.Stream<ComputerUseStatus>;
    /** Installs agent-desktop when it isn't yet, or tries again after a failure. */
    readonly install: Effect.Effect<void, ComputerError>;
    /** Looks again at the operating system's permission, which the user grants outside Cerium. */
    readonly checkPermission: Effect.Effect<void>;
    /** Opens the system's settings at the missing permission, with agent-desktop's guide (macOS). */
    readonly openPermissionGuide: Effect.Effect<void, ComputerError>;
    /** One command that only looks; a screenshot answers with its image. */
    read(caller: Caller, step: Step): Effect.Effect<Answer, ComputerError>;
    /** Commands that act, in order, stopping at the first that fails. */
    act(
      caller: Caller,
      steps: ReadonlyArray<Step>,
      options: { readonly physical: boolean },
    ): Effect.Effect<Answer, ComputerError>;
    /** How to use it: Cerium's notes and agent-desktop's own guide, or one of its references. */
    guide(topic: GuideTopic | undefined): Effect.Effect<string, ComputerError>;
    /** Ends a thread's calls and its cursors, and refuses its agents until `resume`. */
    stop(threadId: ThreadId): Effect.Effect<void>;
    /** Lets a stopped thread's agents use the computer again. */
    resume(threadId: ThreadId): Effect.Effect<void>;
    /** The agent's turn ended: it stops counting as using the computer, and its cursor goes with it. */
    release(agentId: AgentId): Effect.Effect<void>;
    /** Ends every call and every cursor, as turning computer use off does. */
    readonly endAll: Effect.Effect<void>;
  }
>()("cerium/computer/Computer") {
  /** A computer agents can't use, where nothing may drive the desktop (tests). */
  static readonly unavailable = Layer.sync(Computer, () => {
    const unavailable = new ComputerError({
      reason: "unsupported",
      message: "Computer use isn't available here.",
    });
    const status: ComputerUseStatus = {
      tool: { state: "unsupported", version: AGENT_DESKTOP_VERSION, message: unavailable.message },
      sessions: [],
    };
    return Computer.of({
      status: Effect.succeed(status),
      changes: Stream.make(status),
      install: Effect.fail(unavailable),
      checkPermission: Effect.void,
      openPermissionGuide: Effect.fail(unavailable),
      read: () => Effect.fail(unavailable),
      act: () => Effect.fail(unavailable),
      guide: () => Effect.fail(unavailable),
      stop: () => Effect.void,
      resume: () => Effect.void,
      release: () => Effect.void,
      endAll: Effect.void,
    });
  });

  /** Requires `ChildProcessSpawner`, `FileSystem` and `Path`. */
  static readonly layer = (options: ComputerOptions) =>
    Layer.effect(
      Computer,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const release = releaseFor(process.platform, process.arch);
        const installDirectory = path.join(options.toolsDirectory, AGENT_DESKTOP_VERSION);
        const executable = release === undefined ? undefined : path.join(installDirectory, release.files[0]!);

        const status = yield* SubscriptionRef.make<ComputerUseStatus>({
          tool:
            release === undefined
              ? {
                  state: "unsupported",
                  version: AGENT_DESKTOP_VERSION,
                  message: `Computer use isn't available on ${process.platform} ${process.arch}.`,
                }
              : { state: "missing", version: AGENT_DESKTOP_VERSION },
          sessions: [],
        });
        const setTool = (tool: ComputerUseStatus["tool"]) =>
          SubscriptionRef.update(status, (current) => ({ ...current, tool }));

        const threads = new Map<ThreadId, ThreadUse>();
        const paused = new Set<ThreadId>();
        /** Real input from two agents at once would interleave: one at a time. */
        const physicalLock = yield* Semaphore.make(1);
        const installLock = yield* Semaphore.make(1);
        const guides = new Map<string, string>();

        const publishSessions = SubscriptionRef.update(status, (current) => ({
          ...current,
          sessions: [...threads].flatMap(([threadId, use]) =>
            [...use.agents].map(([agentId, agent]): ComputerUseSession => ({
              threadId,
              agentId,
              label: agent.label,
              startedAt: agent.startedAt,
              lastAt: agent.lastAt,
              busy: agent.busy > 0,
            })),
          ),
        }));

        const failure = (reason: ComputerError["reason"], message: string) =>
          new ComputerError({ reason, message });

        /** Runs agent-desktop with `args` and returns what it printed and how it exited. */
        const spawn = (program: string, args: ReadonlyArray<string>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(program, [...args], {
                  env: { AGENT_DESKTOP_HOME: options.stateDirectory },
                  extendEnv: true,
                  stdin: "ignore",
                }),
              );
              const [stdout, stderr] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                ],
                { concurrency: 2 },
              );
              return { stdout, stderr, code: Number(yield* handle.exitCode) };
            }),
          ).pipe(
            Effect.mapError((error) => failure("run", `Cerium couldn't run agent-desktop: ${error.message}`)),
            Effect.timeoutOrElse({
              duration: CALL_TIMEOUT,
              orElse: () => Effect.fail(failure("run", "agent-desktop didn't finish in 2 minutes.")),
            }),
          );

        /** One agent-desktop command's envelope. */
        const command = (args: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const program = yield* ready;
            const { stdout, stderr } = yield* spawn(program, args);
            const envelope = parseEnvelope(stdout);
            if (envelope === undefined) {
              const said = stderr.trim().split(/\r?\n/).at(-1) ?? "";
              return yield* failure("run", `agent-desktop gave no answer${said ? `: ${said}` : "."}`);
            }
            return envelope;
          });

        // ---------------------------------------------------------------------------------------
        // Installing

        const verified = (file: string) =>
          spawn(file, ["version"]).pipe(
            Effect.map(({ stdout }) => {
              const envelope = parseEnvelope(stdout);
              const data = envelope?.data as { readonly version?: unknown } | undefined;
              return (
                envelope?.ok === true &&
                data?.version === AGENT_DESKTOP_VERSION &&
                Number(envelope.version?.split(".")[0]) === CONTRACT_MAJOR
              );
            }),
            Effect.orElseSucceed(() => false),
          );

        const download = (url: string) =>
          Effect.tryPromise({
            try: async (signal) => {
              const response = await fetch(url, { signal, headers: { "user-agent": "Cerium" } });
              if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
              return new Uint8Array(await response.arrayBuffer());
            },
            catch: (cause) =>
              failure(
                "install",
                `Cerium couldn't download agent-desktop ${AGENT_DESKTOP_VERSION}: ${cause instanceof Error ? cause.message : String(cause)}.`,
              ),
          }).pipe(
            Effect.timeoutOrElse({
              duration: Duration.minutes(2),
              orElse: () => Effect.fail(failure("install", "Downloading agent-desktop took too long.")),
            }),
          );

        /** The system's own tar: Windows has bsdtar in System32, where a GNU tar on PATH misreads drives. */
        const tar = () => {
          if (process.platform !== "win32") return "tar";
          const root = process.env["SystemRoot"] ?? process.env["windir"];
          return root === undefined ? "tar" : path.join(root, "System32", "tar.exe");
        };

        const installNow = Effect.gen(function* () {
          if (release === undefined || executable === undefined) {
            return yield* failure("unsupported", `Computer use isn't available on ${process.platform}.`);
          }
          if (
            (yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false))) &&
            (yield* verified(executable))
          ) {
            return;
          }
          yield* setTool({ state: "installing", version: AGENT_DESKTOP_VERSION });
          const archive = yield* download(release.url);
          const digest = createHash("sha256").update(archive).digest("hex");
          if (digest !== release.sha256) {
            return yield* failure(
              "install",
              "The downloaded agent-desktop didn't match the build Cerium trusts, so it wasn't installed.",
            );
          }
          const io = (what: string) => (error: { readonly message: string }) =>
            failure("install", `Cerium couldn't ${what}: ${error.message}`);
          const staging = `${installDirectory}.staging-${process.pid}`;
          yield* fs
            .remove(staging, { recursive: true, force: true })
            .pipe(Effect.mapError(io("prepare its folder")));
          yield* fs
            .makeDirectory(staging, { recursive: true })
            .pipe(Effect.mapError(io("prepare its folder")));
          const archivePath = path.join(staging, release.archive);
          yield* fs.writeFile(archivePath, archive).pipe(Effect.mapError(io("save the download")));
          const unpacked = yield* spawn(tar(), ["-xzf", archivePath, "-C", staging]).pipe(
            Effect.mapError(() => failure("install", "Cerium couldn't unpack agent-desktop.")),
          );
          if (unpacked.code !== 0) {
            return yield* failure(
              "install",
              `Cerium couldn't unpack agent-desktop: ${unpacked.stderr.trim()}`,
            );
          }
          yield* fs.remove(archivePath).pipe(Effect.ignore);
          for (const file of release.files) {
            const unpackedFile = path.join(staging, file);
            if (!(yield* fs.exists(unpackedFile).pipe(Effect.orElseSucceed(() => false)))) {
              return yield* failure("install", `agent-desktop's download had no ${file}.`);
            }
            if (process.platform !== "win32") yield* fs.chmod(unpackedFile, 0o755).pipe(Effect.ignore);
          }
          yield* fs.remove(installDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
          yield* fs.rename(staging, installDirectory).pipe(Effect.mapError(io("put agent-desktop in place")));
          if (!(yield* verified(executable))) {
            return yield* failure("install", "agent-desktop was installed but doesn't start.");
          }
          // Builds of other versions are no longer used.
          const kept = yield* fs.readDirectory(options.toolsDirectory).pipe(Effect.orElseSucceed(() => []));
          for (const entry of kept) {
            if (entry !== AGENT_DESKTOP_VERSION) {
              yield* fs
                .remove(path.join(options.toolsDirectory, entry), { recursive: true, force: true })
                .pipe(Effect.ignore);
            }
          }
        }).pipe(
          Effect.tap(() => setTool({ state: "ready", version: AGENT_DESKTOP_VERSION })),
          Effect.tapError((error) =>
            setTool(
              error.reason === "unsupported"
                ? { state: "unsupported", version: AGENT_DESKTOP_VERSION, message: error.message }
                : { state: "failed", version: AGENT_DESKTOP_VERSION, message: error.message },
            ),
          ),
          installLock.withPermits(1),
        );

        const checkPermission = Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(status)).tool.state !== "ready" || executable === undefined) return;
          const { stdout } = yield* spawn(executable, ["permissions"]);
          const data = parseEnvelope(stdout)?.data as
            | Readonly<Record<string, { readonly state?: unknown } | undefined>>
            | undefined;
          if (data === undefined) return;
          const needed = ["accessibility", "screen_recording"].some((key) => data[key]?.state === "denied");
          const granted = data["accessibility"]?.state === "granted";
          const permission = needed ? "needed" : granted ? "granted" : undefined;
          yield* SubscriptionRef.update(status, (current): ComputerUseStatus =>
            permission === undefined
              ? { tool: current.tool, sessions: current.sessions }
              : { ...current, permission },
          );
        }).pipe(Effect.ignore);

        /** The installed executable, installing it first when it isn't there yet. */
        const ready: Effect.Effect<string, ComputerError> = Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(status)).tool.state !== "ready") {
            yield* installNow;
            yield* checkPermission;
          }
          return executable!;
        });

        // ---------------------------------------------------------------------------------------
        // Sessions

        const endSession = (session: string | undefined) =>
          session === undefined || executable === undefined
            ? Effect.void
            : spawn(executable, ["session", "end", session]).pipe(Effect.ignore);

        /** The thread's agent-desktop session, started with a cursor per agent the first time. */
        const begin = (caller: Caller) =>
          Effect.gen(function* () {
            if (paused.has(caller.threadId)) {
              return yield* failure(
                "stopped",
                "The user stopped computer use in this thread. Don't use the computer again unless they ask you to.",
              );
            }
            let use = threads.get(caller.threadId);
            if (use === undefined) {
              use = { agents: new Map(), stopped: yield* Deferred.make<void>() };
              threads.set(caller.threadId, use);
            }
            if (use.session === undefined) {
              const started = yield* command([
                "session",
                "start",
                "--name",
                SESSION_NAME,
                "--no-trace",
                "--cursor",
                "--multi-agent",
              ]);
              const id = (started.data as { readonly session_id?: unknown } | undefined)?.session_id;
              if (!started.ok || typeof id !== "string") {
                return yield* failure("run", "agent-desktop couldn't start a session.");
              }
              use.session = id;
              use.agents.clear();
            }
            const now = Date.now();
            let agent = use.agents.get(caller.agentId);
            if (agent === undefined) {
              agent = { label: caller.label, startedAt: now, lastAt: now, busy: 0 };
              use.agents.set(caller.agentId, agent);
              // The cursor says whose it is; a computer that can't draw one (Wayland) still works.
              yield* command([
                "--session",
                use.session,
                "--agent-id",
                agentDesktopName(caller.agentId),
                "cursor-overlay",
                "enable",
                "--label",
                caller.label,
              ]).pipe(Effect.ignore);
            }
            agent.busy++;
            agent.lastAt = now;
            yield* publishSessions;
            return { use, agent, session: use.session };
          });

        /** Runs `work` as the caller's call: counted as use, and ended when the user stops the thread. */
        const asCall = <A>(caller: Caller, work: (session: string) => Effect.Effect<A, ComputerError>) =>
          Effect.gen(function* () {
            yield* ready;
            const { use, agent, session } = yield* begin(caller);
            return yield* work(session).pipe(
              Effect.raceFirst(
                Deferred.await(use.stopped).pipe(
                  Effect.andThen(
                    Effect.fail(failure("stopped", "The user stopped computer use in this thread.")),
                  ),
                ),
              ),
              Effect.ensuring(
                Effect.suspend(() => {
                  agent.busy--;
                  agent.lastAt = Date.now();
                  return publishSessions;
                }),
              ),
            );
          });

        const scoped = (caller: Caller, session: string) => [
          "--session",
          session,
          "--agent-id",
          agentDesktopName(caller.agentId),
        ];

        const batch = (caller: Caller, session: string, steps: ReadonlyArray<Step>, physical: boolean) =>
          command([
            ...(physical ? ["--headed"] : []),
            ...scoped(caller, session),
            "batch",
            JSON.stringify(steps.map((step) => (step.args === undefined ? { command: step.command } : step))),
            "--stop-on-error",
            "--timeout-ms",
            String(BATCH_BUDGET_MS),
          ]);

        const answerOf = (envelope: Envelope): Answer => {
          const codes = batchErrorCodes(envelope);
          return { text: capped(batchText(envelope)), ok: envelope.ok && codes.length === 0, codes };
        };

        const screenshot = (caller: Caller, session: string, step: Step) =>
          Effect.gen(function* () {
            const envelope = yield* command([...scoped(caller, session), ...screenshotArgs(step)]);
            const data = envelope.data as
              | {
                  readonly data?: unknown;
                  readonly width?: number;
                  readonly height?: number;
                  readonly scale_factor?: number;
                }
              | undefined;
            if (!envelope.ok || typeof data?.data !== "string") {
              const code = errorCode(envelope.error);
              return {
                text: JSON.stringify({ ok: false, error: envelope.error }),
                ok: false,
                codes: code === undefined ? [] : [code],
              } satisfies Answer;
            }
            const original = Buffer.from(data.data, "base64");
            const fitted = yield* Effect.promise(() => fitPng(original, SCREENSHOT_EDGE, SCREENSHOT_EDGE));
            const captured = `${data.width ?? "?"}×${data.height ?? "?"}`;
            const scale = data.scale_factor === undefined ? "" : `, display scale ${data.scale_factor}`;
            return {
              text:
                fitted === undefined
                  ? `Screenshot, ${captured} pixels${scale}.`
                  : `Screenshot shrunk to ${fitted.width}×${fitted.height} from ${captured} pixels${scale}: multiply a point in it by ${(Number(data.width) / fitted.width).toFixed(3)} for the capture's pixels. Act on refs from snapshot rather than on points where you can.`,
              image: (fitted?.png ?? original).toString("base64"),
              ok: true,
              codes: [],
            } satisfies Answer;
          });

        // Agents quiet for a while stop counting as using the computer; a thread with none left ends
        // its session, which takes their cursors off the screen.
        yield* Effect.gen(function* () {
          const now = Date.now();
          let changed = false;
          for (const [threadId, use] of threads) {
            // A session still starting has no agents yet.
            if (use.session === undefined) continue;
            for (const [agentId, agent] of use.agents) {
              if (agent.busy === 0 && now - agent.lastAt > Duration.toMillis(IDLE)) {
                use.agents.delete(agentId);
                changed = true;
              }
            }
            if (use.agents.size === 0) {
              threads.delete(threadId);
              yield* endSession(use.session);
            }
          }
          if (changed) yield* publishSessions;
        }).pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped);

        const endThread = (threadId: ThreadId) =>
          Effect.gen(function* () {
            const use = threads.get(threadId);
            if (use === undefined) return;
            threads.delete(threadId);
            yield* Deferred.succeed(use.stopped, undefined);
            yield* endSession(use.session);
            yield* publishSessions;
          });

        const endAll = Effect.forEach([...threads.keys()], endThread, { discard: true });

        // A backend that stopped without ending its sessions left its cursors on screen: end those of
        // backends no longer running, then clear away ended sessions.
        yield* Effect.gen(function* () {
          if (
            executable === undefined ||
            !(yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false)))
          ) {
            return;
          }
          const { stdout } = yield* spawn(executable, ["session", "list"]);
          const listed = (parseEnvelope(stdout)?.data as { readonly sessions?: unknown } | undefined)
            ?.sessions;
          for (const session of Array.isArray(listed) ? listed : []) {
            const { session_id: id, name, ended_at: endedAt } = session as Record<string, unknown>;
            const owner = typeof name === "string" ? /^Cerium(?: (\d+))?$/.exec(name) : null;
            if (typeof id !== "string" || endedAt !== null || owner === null) continue;
            if (owner[1] === undefined || !isRunning(Number(owner[1]))) yield* endSession(id);
          }
          yield* spawn(executable, ["session", "gc", "--ended"]);
        }).pipe(Effect.ignore, Effect.forkScoped);

        // Quitting takes every cursor off the screen.
        yield* Effect.addFinalizer(() => endAll.pipe(Effect.timeout("5 seconds"), Effect.ignore));

        return Computer.of({
          status: SubscriptionRef.get(status),
          changes: SubscriptionRef.changes(status),
          install: installNow.pipe(Effect.andThen(checkPermission)),
          checkPermission,
          openPermissionGuide: Effect.gen(function* () {
            const program = yield* ready;
            yield* spawn(program, ["permissions", "--guide"]);
          }),
          read: (caller, step) =>
            Effect.gen(function* () {
              const refused = refusal(step, "read");
              if (refused !== undefined)
                return { text: refused, ok: false, codes: ["REFUSED"] } satisfies Answer;
              return yield* asCall(caller, (session) =>
                step.command === "screenshot"
                  ? screenshot(caller, session, step)
                  : batch(caller, session, [step], false).pipe(Effect.map(answerOf)),
              );
            }),
          act: (caller, steps, { physical }) =>
            Effect.gen(function* () {
              for (const step of steps) {
                const refused = refusal(step, "act");
                if (refused !== undefined)
                  return { text: refused, ok: false, codes: ["REFUSED"] } satisfies Answer;
              }
              const run = asCall(caller, (session) =>
                batch(caller, session, steps, physical).pipe(Effect.map(answerOf)),
              );
              return yield* physical ? physicalLock.withPermits(1)(run) : run;
            }),
          guide: (topic) =>
            Effect.gen(function* () {
              const key = topic ?? "desktop";
              const known = guides.get(key);
              if (known !== undefined) return known;
              const program = yield* ready;
              const args =
                topic === undefined
                  ? ["skills", "get", "desktop"]
                  : topic === "platform"
                    ? ["skills", "get", "platform"]
                    : ["skills", "get", "desktop", topic];
              const { stdout } = yield* spawn(program, args);
              const content = (parseEnvelope(stdout)?.data as { readonly content?: unknown } | undefined)
                ?.content;
              if (typeof content !== "string") {
                return yield* failure("run", `agent-desktop has no guide for ${topic ?? "desktop"}.`);
              }
              const text = guideFor(topic, content.replaceAll("\r\n", "\n"));
              guides.set(key, text);
              return text;
            }),
          stop: (threadId) =>
            Effect.gen(function* () {
              paused.add(threadId);
              yield* endThread(threadId);
            }),
          resume: (threadId) => Effect.sync(() => paused.delete(threadId)),
          release: (agentId) =>
            Effect.gen(function* () {
              for (const [threadId, use] of threads) {
                const agent = use.agents.get(agentId);
                if (agent === undefined || agent.busy > 0) continue;
                use.agents.delete(agentId);
                // The last agent out takes the thread's cursors off the screen.
                if (use.agents.size === 0 && use.session !== undefined) {
                  threads.delete(threadId);
                  yield* endSession(use.session);
                }
                yield* publishSessions;
              }
            }),
          endAll,
        });
      }),
    );
}
