import {
  HarnessFailure,
  HarnessUnavailable,
  replyTo,
  scratchFolder,
  shareProbe,
  type AgentSession,
  type CompletionRequest,
  type ForkRequest,
  type HarnessAdapter,
  type HarnessHub,
  type PastSession,
  type SessionOptions,
  type SideQuestionRequest,
  type SubscriptionReport,
} from "@cerium/harness";
import type { CapabilityManifest, HarnessStatus, ModelInfo, SkillInfo } from "@cerium/protocol";
import { Context, Effect, FileSystem, Option, Path, Result, Scope } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { openAcpAgent, type OpenedAgent } from "./agent.ts";
import { isAuthError, type AcpConnection, type AcpError } from "./connection.ts";
import { quietOptions, refinedManifest, type AcpHarness, type LaunchPurpose } from "./harness.ts";
import { listAcpSessions, readAcpSession } from "./history.ts";
import { modelsFromSetup } from "./models.ts";
import type { InitializeResponse, SessionSetup } from "./schema.ts";
import { startAcpSession } from "./session.ts";

// A `HarnessAdapter` for any ACP agent, from its definition and probe. Sessions, completions, side
// questions, forks, model listing and history all speak ACP; a harness adds only what ACP doesn't
// carry (where its binary is, its plan's meters, its skills).

export type Platform = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;

/** What the agent says about itself without a turn: its handshake, and a fresh session's setup. */
export interface AcpInspection {
  readonly initialized: InitializeResponse;
  /** Absent when no session could be opened: `signedIn` false, or the agent refused (`error`). */
  readonly setup?: SessionSetup;
  readonly signedIn: boolean;
  readonly error?: string;
}

/** A signed-in agent in Cerium's own folder, outside any project, for one of Cerium's own jobs. */
export const withAcpAgent = <A, E, R>(
  harness: AcpHarness,
  executablePath: string,
  purpose: LaunchPurpose,
  use: (agent: OpenedAgent, cwd: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const cwd = yield* scratchFolder(harness.provider, "acp");
    const agent = yield* openAcpAgent(harness, executablePath, {
      purpose,
      cwd,
      access: "readOnly",
      includeUserMcpServers: false,
      injectedMcpServers: [],
    });
    return yield* use(agent, cwd);
  }).pipe(Effect.scoped);

/**
 * Starts the agent in Cerium's own folder, signs it in, and opens (then closes and deletes, where it
 * can) a session to see what it would offer.
 */
export const inspectAcpAgent = (harness: AcpHarness, executablePath: string) =>
  withAcpAgent(harness, executablePath, "probe", (agent, cwd) =>
    Effect.gen(function* () {
      const { connection } = agent;
      const initialized = connection.initialized;
      if (!agent.signedIn) {
        return {
          initialized,
          signedIn: false,
          ...(agent.signInError ? { error: agent.signInError } : {}),
        } satisfies AcpInspection;
      }
      const opened = yield* connection
        .request<SessionSetup>("session/new", {
          cwd,
          mcpServers: [],
          ...(agent.command.sessionMeta === undefined ? {} : { _meta: { ...agent.command.sessionMeta } }),
        })
        .pipe(Effect.result);
      if (Result.isFailure(opened)) {
        const error: AcpError = opened.failure;
        return { initialized, signedIn: !isAuthError(error), error: error.message } satisfies AcpInspection;
      }
      const setup = opened.success;
      const sessionId = setup.sessionId;
      const lifecycle = initialized.agentCapabilities?.sessionCapabilities ?? {};
      if (typeof sessionId === "string") {
        if (lifecycle.close) yield* connection.request("session/close", { sessionId }).pipe(Effect.ignore);
        const remove = lifecycle.delete
          ? connection.request("session/delete", { sessionId })
          : harness.deleteSession?.(connection, sessionId, cwd);
        if (remove !== undefined) yield* remove.pipe(Effect.ignore);
      }
      return { initialized, setup, signedIn: true } satisfies AcpInspection;
    }),
  );

export interface AcpAdapterSpec {
  readonly harness: AcpHarness;
  readonly installHint: string;
  /** Finds the harness and reads its sign-in. */
  readonly probe: Effect.Effect<HarnessStatus, HarnessFailure, Platform>;
  /**
   * The models an agent names in `initialize` (Grok's `_meta.modelState`), read before opening a
   * throwaway session to find them. None falls back to the session's config options.
   */
  readonly models?: (initialized: InitializeResponse) => ReadonlyArray<ModelInfo>;
  /** Models to offer when the agent lists none over ACP (an agent that picks models by flag). */
  readonly fallbackModels?: (
    executablePath: string,
  ) => Effect.Effect<ReadonlyArray<ModelInfo>, HarnessFailure, Platform>;
  readonly usage?: (
    executablePath: string,
  ) => Effect.Effect<Option.Option<SubscriptionReport>, HarnessUnavailable | HarnessFailure, Platform>;
  readonly listSkills?: (
    executablePath: string,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<SkillInfo>, HarnessUnavailable | HarnessFailure, Platform>;
  readonly hub?: (platform: Context.Context<Platform>) => HarnessHub;
}

/**
 * Builds the adapter. Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path`. The
 * manifest is the definition's, narrowed by what the installed agent advertised once Cerium has spoken
 * to it.
 */
export const makeAcpAdapter = Effect.fn("AcpAdapter.make")(function* (spec: AcpAdapterSpec) {
  const { harness } = spec;
  // Only these services: the layer's whole context would also carry its Scope, which would then
  // replace the scope a session is started in.
  const platform = Context.pick(
    ChildProcessSpawner.ChildProcessSpawner,
    FileSystem.FileSystem,
    Path.Path,
  )(yield* Effect.context<Platform>());
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Platform>> =>
    Effect.provide(effect, platform);

  let advertised: InitializeResponse | undefined;
  const remember = (initialized: InitializeResponse) => Effect.sync(() => void (advertised = initialized));
  const manifest = (): CapabilityManifest =>
    advertised?.agentCapabilities === undefined
      ? harness.manifest
      : harness.refineManifest !== undefined
        ? harness.refineManifest(harness.manifest, advertised.agentCapabilities)
        : refinedManifest(harness.manifest, advertised.agentCapabilities);

  const probes = yield* shareProbe(provide(spec.probe));
  const signedOutMessage = `${harness.name} is not signed in${harness.loginCommand ? `. Run \`${harness.loginCommand}\`.` : "."}`;
  const signedOut = () =>
    new HarnessUnavailable({ provider: harness.provider, reason: "loggedOut", message: signedOutMessage });

  /** The installed executable, once it is known to be usable. */
  const ready = Effect.gen(function* () {
    const status = yield* probes.kept;
    if (status._tag === "HarnessMissing") {
      return yield* new HarnessUnavailable({
        provider: harness.provider,
        reason: "notInstalled",
        message: spec.installHint,
      });
    }
    if (status.auth._tag === "LoggedOut") return yield* signedOut();
    return status.executablePath;
  });

  /** A session in an access mode the machine can't run yet (a sandbox still to set up) can't start. */
  const runnable = (options: SessionOptions) =>
    Effect.gen(function* () {
      const status = yield* probes.kept;
      if (status._tag !== "HarnessInstalled") return;
      const blocked =
        status.setup?.blocks.includes(options.access) === true
          ? `${status.setup.reason} Run \`${status.setup.command}\`${status.setup.elevated ? " as an administrator" : ""}, or pick another access mode.`
          : status.limit?.blocks.includes(options.access) === true
            ? `${harness.name} can't run in this access mode here: ${status.limit.reason}`
            : undefined;
      if (blocked !== undefined) {
        return yield* new HarnessFailure({
          provider: harness.provider,
          message: blocked,
          cause: options.access,
        });
      }
    });

  /** The connections of the sessions running now, by session id, for side questions put to them. */
  const live = new Map<string, AcpConnection>();

  const startSession = (
    options: SessionOptions,
  ): Effect.Effect<AgentSession, HarnessUnavailable | HarnessFailure, Scope.Scope> =>
    Effect.gen(function* () {
      const executablePath = yield* ready;
      yield* runnable(options);
      const session = yield* provide(startAcpSession(harness, executablePath, options));
      const { connection, sessionId } = session.opened;
      yield* remember(connection.initialized);
      live.set(sessionId, connection);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => live.get(sessionId) === connection && live.delete(sessionId)),
      );
      return probes.watchSignIn(session, signedOutMessage);
    });

  const listModels = Effect.gen(function* () {
    const executablePath = yield* ready;
    if (spec.models !== undefined) {
      const announced = yield* provide(
        withAcpAgent(harness, executablePath, "probe", (agent) =>
          Effect.gen(function* () {
            yield* remember(agent.connection.initialized);
            if (!agent.signedIn) return yield* signedOut();
            return spec.models!(agent.connection.initialized);
          }),
        ),
      );
      if (announced.length > 0) return announced;
    }
    const inspection = yield* provide(inspectAcpAgent(harness, executablePath));
    yield* remember(inspection.initialized);
    if (!inspection.signedIn) return yield* signedOut();
    const listed = inspection.setup === undefined ? [] : modelsFromSetup(harness.provider, inspection.setup);
    if (listed.length > 0 || spec.fallbackModels === undefined) return listed;
    return yield* provide(spec.fallbackModels(executablePath));
  });

  const complete = (request: CompletionRequest) =>
    Effect.gen(function* () {
      const executablePath = yield* ready;
      const session = yield* provide(
        startAcpSession(
          harness,
          executablePath,
          quietOptions({
            cwd: request.cwd,
            model: request.model,
            effort: "minimal",
            appendSystemPrompt: request.instructions,
          }),
          { purpose: "completion", ephemeral: true },
        ),
      );
      return yield* replyTo(session, harness.provider, request.prompt, request.onUsage);
    }).pipe(Effect.scoped);

  /**
   * A side question: to the session's own process where the harness can ask one aside (it then sees
   * the turn in flight), else to a copy of the session that is deleted with the answer.
   */
  const sideQuestion = (request: SideQuestionRequest) =>
    Effect.gen(function* () {
      const running = live.get(request.sessionId);
      if (running !== undefined && harness.sideQuestion !== undefined && !running.hasExited()) {
        return yield* harness
          .sideQuestion(running, request.sessionId, `${request.instructions}\n\n${request.prompt}`)
          .pipe(
            Effect.mapError(
              (cause) =>
                new HarnessFailure({
                  provider: harness.provider,
                  message: `${harness.name} couldn't answer aside: ${cause.message}`,
                  cause,
                }),
            ),
          );
      }
      const executablePath = yield* ready;
      const session = yield* provide(
        startAcpSession(
          harness,
          executablePath,
          quietOptions({ cwd: request.cwd, model: request.model, appendSystemPrompt: request.instructions }),
          { purpose: "sideQuestion", ephemeral: true, forkOf: { sessionId: request.sessionId } },
        ),
      );
      return yield* replyTo(session, harness.provider, request.prompt, request.onUsage);
    }).pipe(Effect.scoped);

  const fork = (request: ForkRequest) =>
    Effect.gen(function* () {
      const executablePath = yield* ready;
      if (harness.fork === undefined) {
        return yield* new HarnessFailure({
          provider: harness.provider,
          message: `${harness.name} can't copy part of a session`,
          cause: request,
        });
      }
      return yield* provide(
        withAcpAgent(harness, executablePath, "history", (agent) =>
          Effect.gen(function* () {
            if (!agent.signedIn) return yield* signedOut();
            return yield* harness.fork!(agent.connection, {
              sessionId: request.sessionId,
              cwd: request.cwd,
              promptIndex: request.before.index,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new HarnessFailure({
                    provider: harness.provider,
                    message: `${harness.name} couldn't copy the session: ${cause.message}`,
                    cause,
                  }),
              ),
            );
          }),
        ),
      );
    });

  /** A signed-in connection in Cerium's own folder, for reading the user's sessions. */
  const withHistory = <A>(
    use: (connection: AcpConnection, cwd: string) => Effect.Effect<A, HarnessFailure | HarnessUnavailable>,
  ) =>
    ready.pipe(
      Effect.flatMap((executablePath) =>
        provide(
          withAcpAgent(harness, executablePath, "history", (agent, cwd) =>
            Effect.gen(function* () {
              yield* remember(agent.connection.initialized);
              if (!agent.signedIn) return yield* signedOut();
              return yield* use(agent.connection, cwd);
            }),
          ),
        ),
      ),
    );

  const listSessions = withHistory((connection) =>
    connection.initialized.agentCapabilities?.sessionCapabilities?.list
      ? listAcpSessions(harness, connection)
      : Effect.succeed([] as ReadonlyArray<PastSession>),
  );
  const readSession = (session: PastSession) =>
    withHistory((connection, cwd) =>
      connection.initialized.agentCapabilities?.loadSession === true
        ? readAcpSession(harness, connection, session, cwd)
        : Effect.fail(
            new HarnessFailure({
              provider: harness.provider,
              message: `${harness.name} can't replay a session's history`,
              cause: session.id,
            }),
          ),
    );

  const adapter: HarnessAdapter = {
    provider: harness.provider,
    get manifest() {
      return manifest();
    },
    probe: probes.fresh,
    listModels,
    complete,
    sideQuestion,
    ...(harness.fork === undefined ? {} : { fork }),
    listSessions,
    readSession,
    startSession,
    ...(spec.usage === undefined
      ? {}
      : { usage: ready.pipe(Effect.flatMap((executablePath) => provide(spec.usage!(executablePath)))) }),
    ...(spec.listSkills === undefined
      ? {}
      : {
          listSkills: (cwd: string) =>
            ready.pipe(Effect.flatMap((executablePath) => provide(spec.listSkills!(executablePath, cwd)))),
        }),
    ...(spec.hub === undefined ? {} : { hub: spec.hub(platform) }),
  };
  return adapter;
});
