import { deviceHandlers } from "@cerium/account";
import { Adapters, Orchestrator, UserSettings, type OrchestratorError } from "@cerium/orchestrator";
import { isStreamDelta, type ProviderId, type SkillInfo } from "@cerium/protocol";
import { CeriumError, CeriumRpcs, MachineRpcs } from "@cerium/rpc";
import { Store, type StoreError } from "@cerium/store";
import { Cache, Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";

import { Files, type FilesError } from "./files.ts";
import { Projects, type ProjectError } from "./project.ts";
import { Terminals, terminalHandlers } from "./terminal.ts";
import { Workspace, type WorkspaceError } from "./workspace.ts";

export const RPC_PATH = "/rpc";

const refuse = (error: OrchestratorError | WorkspaceError | ProjectError | FilesError | StoreError) =>
  new CeriumError({ message: error.message });

/** How many matches the `@` list shows. */
const SEARCH_LIMIT = 50;

/** How many threads the thread search lists. */
const THREAD_SEARCH_LIMIT = 30;

/** What this machine serves its own UI and, through the relay, other devices. */
export const Handlers = MachineRpcs.toLayer(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const adapters = yield* Adapters;
    const settings = yield* UserSettings;
    const workspace = yield* Workspace;
    const files = yield* Files;
    const projects = yield* Projects;
    const terminals = yield* Terminals;
    const store = yield* Store;

    // Claude only lists its skills from inside a session, which takes a few seconds to start; the
    // list barely changes, so each folder's is kept for a minute. Keyed `provider:cwd`.
    const skills = yield* Cache.make({
      capacity: 32,
      timeToLive: "1 minute",
      lookup: (key: string) => {
        const split = key.indexOf(":");
        const provider = key.slice(0, split) as ProviderId;
        const cwd = key.slice(split + 1);
        const adapter = adapters.get(provider);
        return adapter?.listSkills === undefined
          ? Effect.succeed<ReadonlyArray<SkillInfo>>([])
          : adapter
              .listSkills(cwd)
              .pipe(Effect.mapError((error) => new CeriumError({ message: error.message })));
      },
    });

    return MachineRpcs.of({
      ListThreads: () => orchestrator.threadOverviews.pipe(Effect.mapError(refuse)),
      ThreadEvents: ({ threadId }) => orchestrator.threadEvents(threadId).pipe(Effect.mapError(refuse)),
      WatchEvents: () => orchestrator.events,
      // A work thread's folder joins the projects the composer offers, as the one used last.
      CreateThread: (payload) =>
        orchestrator.createThread(payload).pipe(
          Effect.tap(({ thread }) =>
            thread.mode === "work" && thread.cwd !== undefined
              ? projects.save(thread.cwd).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.mapError(refuse),
        ),
      SendMessage: ({ agentId, text, attachments, mentions }) =>
        orchestrator
          .sendUserMessage(agentId, text, {
            ...(attachments ? { attachments } : {}),
            ...(mentions ? { mentions } : {}),
          })
          .pipe(Effect.mapError(refuse)),
      SwitchModel: ({ agentId, model, effort }) =>
        orchestrator
          .switchModel(agentId, { model, ...(effort ? { effort } : {}) })
          .pipe(Effect.mapError(refuse)),
      RespondToPermission: ({ agentId, requestId, decision, scope }) =>
        orchestrator
          .respondToPermission(agentId, requestId, { decision, scope })
          .pipe(Effect.mapError(refuse)),
      AnswerQuestion: ({ agentId, requestId, response }) =>
        orchestrator.answerQuestion(agentId, requestId, response).pipe(Effect.mapError(refuse)),
      ResolveSpawnApproval: ({ requestId, decision, replacement }) =>
        orchestrator
          .resolveSpawnApproval(requestId, { decision, ...(replacement ? { replacement } : {}) })
          .pipe(Effect.mapError(refuse)),
      InterruptAgent: ({ agentId, includeChildren }) =>
        orchestrator
          .interruptAgent(agentId, includeChildren === undefined ? {} : { includeChildren })
          .pipe(Effect.mapError(refuse)),
      StopAgent: ({ agentId }) => orchestrator.stopAgent(agentId).pipe(Effect.mapError(refuse)),
      RenameThread: ({ threadId, title }) =>
        orchestrator.renameThread(threadId, title).pipe(Effect.mapError(refuse)),
      SetThreadArchived: ({ threadId, archived }) =>
        orchestrator.setThreadArchived(threadId, archived).pipe(Effect.mapError(refuse)),
      // A deleted thread's terminals end with it.
      DeleteThread: ({ threadId }) =>
        orchestrator.deleteThread(threadId).pipe(
          Effect.tap(() => terminals.closeThread(threadId)),
          Effect.mapError(refuse),
        ),
      SearchThreads: ({ query, mode }) =>
        store.searchMessages(query, { mode, limit: THREAD_SEARCH_LIMIT }).pipe(Effect.mapError(refuse)),
      HarnessStatuses: () =>
        Effect.forEach([...adapters.values()], (adapter) => Effect.option(adapter.probe), {
          concurrency: "unbounded",
        }).pipe(Effect.map((statuses) => statuses.flatMap(Option.toArray))),
      HarnessManifests: () => Effect.succeed([...adapters.values()].map((adapter) => adapter.manifest)),
      LoginHarness: ({ provider }) =>
        Stream.unwrap(
          Effect.fromNullishOr(adapters.get(provider)?.login).pipe(
            Effect.mapError(
              () => new CeriumError({ message: `${provider} has no sign-in Cerium can start.` }),
            ),
          ),
        ).pipe(Stream.mapError((error) => new CeriumError({ message: error.message }))),
      ListModels: ({ provider }) =>
        Effect.fromNullishOr(adapters.get(provider)).pipe(
          Effect.mapError(() => new CeriumError({ message: `No ${provider} adapter is installed.` })),
          Effect.flatMap((adapter) => adapter.listModels),
          Effect.mapError((error) => new CeriumError({ message: error.message })),
        ),
      SearchWorkspace: ({ cwd, query }) =>
        workspace.search(cwd, query, SEARCH_LIMIT).pipe(Effect.mapError(refuse)),
      ListSkills: ({ provider, cwd }) => Cache.get(skills, `${provider}:${cwd ?? homedir()}`),
      SaveAttachment: ({ name, mediaType, data }) =>
        workspace.saveAttachment(name, mediaType, data).pipe(Effect.mapError(refuse)),
      ReadImage: ({ path }) => workspace.readImage(path).pipe(Effect.mapError(refuse)),
      ListFiles: ({ root, dir }) => files.list(root, dir).pipe(Effect.mapError(refuse)),
      FileStatuses: ({ root }) => files.statuses(root).pipe(Effect.mapError(refuse)),
      ReadFile: ({ root, path }) => files.read(root, path).pipe(Effect.mapError(refuse)),
      ReadFileBytes: ({ root, path }) => files.readBytes(root, path).pipe(Stream.mapError(refuse)),
      DiffFile: ({ root, path, from, context }) =>
        files.diff(root, path, from, context).pipe(Effect.mapError(refuse)),
      WatchFiles: ({ root }) => files.watch(root).pipe(Stream.mapError(refuse)),
      ListProjects: () => projects.list.pipe(Effect.mapError(refuse)),
      SaveProject: ({ path }) => projects.save(path).pipe(Effect.mapError(refuse)),
      RemoveProject: ({ path }) => projects.remove(path).pipe(Effect.mapError(refuse)),
      GitBranch: ({ cwd }) => projects.branch(cwd).pipe(Effect.map((branch) => (branch ? { branch } : {}))),
      ProjectIcon: ({ cwd }) => projects.icon(cwd).pipe(Effect.map((icon) => (icon ? { icon } : {}))),
      Settings: () => settings.get,
      UpdateSettings: (patch) => settings.update(patch).pipe(Effect.mapError(refuse)),
      ...terminalHandlers(terminals),
    });
  }),
);

/** Whether this machine's agents are working, re-checked after every event but streamed text. */
const working = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  const busy = orchestrator.threadOverviews.pipe(
    Effect.map((overviews) =>
      overviews.some(({ agents }) =>
        agents.some((agent) => agent.state === "running" || agent.state === "queued"),
      ),
    ),
    Effect.orElseSucceed(() => false),
  );
  return Stream.concat(
    Stream.succeed(undefined),
    orchestrator.events.pipe(Stream.filter((event) => !isStreamDelta(event.payload._tag))),
  ).pipe(
    Stream.mapEffect(() => busy),
    Stream.changes,
  );
});

/** What this machine answers its own UI about itself: its account, the account's threads, its work. */
const DeviceHandlers = deviceHandlers(working);

const sameSecret = (given: string, expected: string) =>
  given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));

/**
 * Only the UI holding this launch's token may connect. Browsers can't set WebSocket headers, so the
 * token travels in the query string; the check happens before the upgrade.
 */
export const requireToken = (token: string) =>
  HttpRouter.middleware((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const given = new URL(request.url, "http://localhost").searchParams.get("token") ?? "";
      if (!sameSecret(given, token)) return HttpServerResponse.empty({ status: 401 });
      return yield* httpEffect;
    }),
  ).layer;

/**
 * The UI's RPC endpoint. Requires the Orchestrator, Adapters, UserSettings, Workspace, Files, Projects,
 * Account, CloudThreads and an HttpRouter.
 */
export const rpcRoutes = (token: string) =>
  RpcServer.layer(CeriumRpcs).pipe(
    Layer.provide(Layer.merge(Handlers, DeviceHandlers)),
    Layer.provide(
      RpcServer.layerProtocolWebsocket({ path: RPC_PATH }).pipe(Layer.provide(requireToken(token))),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

/**
 * The RPC server for tunnelled channels: the machine's RPCs, never the
 * device's own, which only its own UI may call. Requires what the handlers do and a `SocketServer`.
 */
export const tunnelRpcServer = RpcServer.layer(MachineRpcs).pipe(
  Layer.provide(Handlers),
  Layer.provide(RpcServer.layerProtocolSocketServer),
  Layer.provide(RpcSerialization.layerJson),
);
