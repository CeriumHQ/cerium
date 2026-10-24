import { deviceHandlers } from "@cerium/account";
import { newestArtifacts } from "@cerium/artifacts";
import { previewArtifact } from "@cerium/artifacts/preview";
import type { HarnessAdapter } from "@cerium/harness";
import {
  Adapters,
  Checkpoints,
  Orchestrator,
  UserSettings,
  type EffortDecisionError,
  type OrchestratorError,
} from "@cerium/orchestrator";
import {
  isStreamDelta,
  LEAD_ROLE,
  toolOutputImages,
  withoutImages,
  type AgentEvent,
  type HarnessStatus,
  type ProviderId,
  type SkillInfo,
} from "@cerium/protocol";
import {
  CeriumError,
  CeriumRpcs,
  MachineRpcs,
  type GitError,
  type GitHubStatus,
  type ListedArtifact,
} from "@cerium/rpc";
import { Store, type StoreError } from "@cerium/store";
import { Cache, Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";

import { Repositories, type RepositoryError } from "./clone.ts";
import { Drafts } from "./drafts.ts";
import { EffortRouter } from "./effortRouter.ts";
import { fileDiffOf, Files, resolveInside, type FilesError } from "./files.ts";
import { GitBranches, gitBranchHandlers } from "./gitBranches.ts";
import { GitChanges, gitChangesHandlers } from "./gitChanges.ts";
import { GitHub } from "./github.ts";
import { issueHandlers } from "./githubIssues.ts";
import { githubHandlers } from "./githubPulls.ts";
import { History, type HistoryError } from "./history.ts";
import { Notifications } from "./notify.ts";
import { Projects, type ProjectError } from "./project.ts";
import { newerRelease, Releases } from "./releases.ts";
import { spendReport } from "./spend.ts";
import { Terminals, terminalHandlers } from "./terminal.ts";
import { commandChoice } from "./terminalShell.ts";
import { SubscriptionUsage } from "./usage.ts";
import { Workspace, type WorkspaceError } from "./workspace.ts";

export const RPC_PATH = "/rpc";

const refuse = (
  error:
    | OrchestratorError
    | WorkspaceError
    | ProjectError
    | FilesError
    | HistoryError
    | RepositoryError
    | GitError
    | StoreError,
) => new CeriumError({ message: error.message });

const refuseDecision = (error: EffortDecisionError) => new CeriumError({ message: error.message });

/** A snapshot of a folder, as `TurnFilesChanged` names one: a git tree's id. */
const isSnapshot = (id: string) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id);

/** How many matches the `@` list shows. */
const SEARCH_LIMIT = 50;

/** How many commits one page of the History tab lists. */
const COMMIT_PAGE = 50;

/** The tested range viewers before `RPC_VERSION` 20 read in a manifest: one every version is inside. */
const ANY_VERSION = { minimum: "0.0.0", testedMaximum: "99999.0.0" };

/** How many threads the thread search lists. */
const THREAD_SEARCH_LIMIT = 30;

/** How an artifact's fence starts in a message; a longer backtick fence holds the first. */
const ARTIFACT_FENCES = ["```artifact", "~~~artifact"];

/** How many messages, and artifacts, the artifacts panel lists for a project. */
const ARTIFACT_MESSAGES = 200;
const ARTIFACT_LIMIT = 120;

/** The artifacts in completed messages given newest first (each once), newest first. */
const listedArtifacts = (messages: ReadonlyArray<AgentEvent>): Array<ListedArtifact> => {
  const completed = new Map<
    string,
    { threadId: AgentEvent["threadId"]; at: number; messageId: string; text: string }
  >();
  for (const { id, threadId, at, payload } of messages) {
    if (payload._tag === "MessageCompleted" && !completed.has(id)) {
      completed.set(id, { threadId, at, messageId: payload.messageId, text: payload.text });
    }
  }
  return newestArtifacts(completed.values(), ARTIFACT_LIMIT).map(({ message, code }) => ({
    threadId: message.threadId,
    messageId: message.messageId,
    at: message.at,
    code,
  }));
};

/** What this machine serves its own UI and, through the relay, other devices. */
export const Handlers = MachineRpcs.toLayer(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const adapters = yield* Adapters;
    const settings = yield* UserSettings;
    const workspace = yield* Workspace;
    const files = yield* Files;
    const github = yield* GitHub;
    const gitBranches = yield* GitBranches;
    const gitChanges = yield* GitChanges;
    const drafts = yield* Drafts;
    const history = yield* History;
    const checkpoints = yield* Checkpoints;
    const repositories = yield* Repositories;
    const projects = yield* Projects;
    const terminals = yield* Terminals;
    const store = yield* Store;
    const usage = yield* SubscriptionUsage;
    const releases = yield* Releases;
    const effortRouter = yield* EffortRouter;

    /**
     * A harness's status as Settings shows it: with its newest release when that's newer, the command
     * that updates it, and the version verdict viewers before `RPC_VERSION` 20 expect.
     */
    const described = (adapter: HarnessAdapter) => {
      const source = adapter.manifest.releases;
      return Effect.all(
        [
          adapter.probe,
          source === undefined ? Effect.succeedNone : releases.latest({ npm: source.npmPackage }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([status, latest]): HarnessStatus => {
          if (status._tag === "HarnessMissing") return status;
          const newer = newerRelease(status.version, Option.getOrUndefined(latest));
          return {
            ...status,
            versionStatus: "supported",
            ...(newer === undefined ? {} : { latestVersion: newer }),
            ...(source?.updateCommand === undefined ? {} : { updateCommand: source.updateCommand }),
          };
        }),
      );
    };

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
      ThreadEvents: ({ threadId, withoutImages: lean }) =>
        orchestrator.threadEvents(threadId).pipe(
          Effect.map((events) => (lean === true ? events.map(withoutImages) : events)),
          Effect.mapError(refuse),
        ),
      ToolImage: ({ threadId, callId, index }) =>
        store.findToolCompletion(threadId, callId).pipe(
          Effect.mapError(refuse),
          Effect.flatMap((found) => {
            const payload = Option.getOrUndefined(found)?.payload;
            const image =
              payload?._tag === "ToolCallCompleted" ? toolOutputImages(payload.output)[index] : undefined;
            return image === undefined
              ? Effect.fail(new CeriumError({ message: "That image isn't in the thread anymore." }))
              : Effect.succeed(image);
          }),
        ),
      WatchEvents: () => orchestrator.events,
      // A work thread's folder joins the projects the composer offers, as the one used last: the
      // project's own, for a thread in a worktree.
      CreateThread: (payload) =>
        orchestrator.createThread(payload).pipe(
          Effect.tap(({ thread }) => {
            const folder = thread.worktree?.project ?? thread.cwd;
            return thread.mode === "work" && folder !== undefined
              ? projects.save(folder).pipe(Effect.ignore)
              : Effect.void;
          }),
          Effect.mapError(refuse),
        ),
      SendMessage: ({ agentId, text, attachments, mentions }) =>
        orchestrator
          .sendUserMessage(agentId, text, {
            ...(attachments ? { attachments } : {}),
            ...(mentions ? { mentions } : {}),
          })
          .pipe(Effect.mapError(refuse)),
      EditMessage: ({ agentId, messageId, text, attachments, mentions }) =>
        orchestrator
          .editMessage(agentId, messageId, text, {
            ...(attachments ? { attachments } : {}),
            ...(mentions ? { mentions } : {}),
          })
          .pipe(Effect.mapError(refuse)),
      PreviewRestore: ({ agentId, messageId }) =>
        orchestrator.previewRestore(agentId, messageId).pipe(Effect.mapError(refuse)),
      RevertTurnFiles: ({ agentId, turnId, direction }) =>
        orchestrator.revertTurn(agentId, turnId, direction).pipe(Effect.mapError(refuse)),
      RestoreBefore: ({ agentId, messageId }) =>
        orchestrator.restoreBefore(agentId, messageId).pipe(Effect.mapError(refuse)),
      SwitchModel: ({ agentId, model, effort, autoEffort }) =>
        orchestrator
          .switchModel(agentId, {
            model,
            ...(effort ? { effort } : {}),
            ...(autoEffort === undefined ? {} : { autoEffort }),
          })
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
      SteerAgent: ({ agentId }) => orchestrator.steerAgent(agentId).pipe(Effect.mapError(refuse)),
      WithdrawMessage: ({ agentId, messageId }) =>
        orchestrator.withdrawMessage(agentId, messageId).pipe(Effect.mapError(refuse)),
      StopAgent: ({ agentId }) => orchestrator.stopAgent(agentId).pipe(Effect.mapError(refuse)),
      StopThread: ({ threadId }) => orchestrator.stopThread(threadId).pipe(Effect.mapError(refuse)),
      RenameThread: ({ threadId, title }) =>
        orchestrator.renameThread(threadId, title).pipe(Effect.mapError(refuse)),
      SetThreadArchived: ({ threadId, archived, discardWork }) =>
        orchestrator
          .setThreadArchived(threadId, archived, discardWork === undefined ? {} : { discardWork })
          .pipe(Effect.mapError(refuse)),
      SetThreadLater: ({ threadId, until }) =>
        orchestrator.setThreadLater(threadId, until).pipe(Effect.mapError(refuse)),
      // A deleted thread's terminals end with it.
      DeleteThread: ({ threadId, discardWork }) =>
        orchestrator.deleteThread(threadId, discardWork === undefined ? {} : { discardWork }).pipe(
          Effect.tap(() => terminals.closeThread(threadId)),
          Effect.mapError(refuse),
        ),
      WorktreeChanges: ({ threadId }) => orchestrator.worktreeChanges(threadId).pipe(Effect.mapError(refuse)),
      SearchThreads: ({ query, mode }) =>
        store.searchMessages(query, { mode, limit: THREAD_SEARCH_LIMIT }).pipe(Effect.mapError(refuse)),
      HarnessStatuses: () =>
        Effect.forEach([...adapters.values()], (adapter) => Effect.option(described(adapter)), {
          concurrency: "unbounded",
        }).pipe(Effect.map((statuses) => statuses.flatMap(Option.toArray))),
      // Viewers before `RPC_VERSION` 20 read a tested range, which no version falls outside.
      HarnessManifests: () =>
        Effect.succeed(
          [...adapters.values()].map((adapter) => ({ ...adapter.manifest, harnessVersion: ANY_VERSION })),
        ),
      WatchSubscriptionUsage: () => usage.watch,
      SpendReport: ({ edges }) =>
        Effect.gen(function* () {
          if (edges.some((edge, index) => index > 0 && edge <= edges[index - 1]!)) {
            return yield* new CeriumError({ message: "The report's edges must ascend." });
          }
          const [events, agents, threads] = yield* Effect.all([
            store.listSpendEvents(edges[0]!, edges.at(-1)!),
            store.listAllAgents,
            store.listThreads,
          ]);
          return spendReport({ events, agents, threads, edges });
        }).pipe(Effect.mapError((error) => (error instanceof CeriumError ? error : refuse(error)))),
      LoginHarness: ({ provider }) =>
        Stream.unwrap(
          Effect.fromNullishOr(adapters.get(provider)?.login).pipe(
            Effect.mapError(
              () => new CeriumError({ message: `${provider} has no sign-in Cerium can start.` }),
            ),
          ),
        ).pipe(Stream.mapError((error) => new CeriumError({ message: error.message }))),
      RunHarnessCommand: ({ provider, action, size }) =>
        Effect.gen(function* () {
          const adapter = adapters.get(provider);
          if (adapter === undefined) {
            return yield* new CeriumError({ message: `No ${provider} adapter is installed.` });
          }
          const status = yield* adapter.probe.pipe(
            Effect.mapError((error) => new CeriumError({ message: error.message })),
          );
          if (status._tag === "HarnessMissing") {
            return yield* new CeriumError({ message: status.installHint });
          }
          const command =
            action === "login"
              ? status.auth._tag === "LoggedOut"
                ? status.auth.loginCommand
                : undefined
              : adapter.manifest.releases?.updateCommand;
          if (command === undefined) {
            return yield* new CeriumError({
              message:
                action === "login"
                  ? "That harness is signed in, or signs in another way."
                  : "That harness has no update command Cerium can run.",
            });
          }
          return yield* terminals
            .run(
              `${provider}:${action}`,
              commandChoice(process.platform, status.executablePath, command),
              size,
            )
            .pipe(Effect.mapError((error) => new CeriumError({ message: error.message })));
        }),
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
      RenderArtifact: ({ html, width, mode, variables }) =>
        Effect.tryPromise({
          try: () =>
            previewArtifact({ html, width, mode, theme: { mode, variables }, scale: 2, standalone: true }),
          catch: (cause) =>
            new CeriumError({
              message: cause instanceof Error ? cause.message : "Couldn't draw the artifact.",
            }),
        }).pipe(
          Effect.map(({ png }) => ({ mediaType: "image/png", data: Buffer.from(png).toString("base64") })),
        ),
      ListArtifacts: ({ folder }) =>
        Effect.gen(function* () {
          const leads = (yield* orchestrator.threadOverviews).flatMap(({ thread, agents }) =>
            thread.archivedAt === undefined && (thread.worktree?.project ?? thread.cwd) === folder
              ? agents.flatMap((agent) => (agent.role === LEAD_ROLE ? [agent.id] : []))
              : [],
          );
          const messages = (yield* Effect.forEach(ARTIFACT_FENCES, (fence) =>
            store.listMessagesContaining(leads, fence, ARTIFACT_MESSAGES),
          ))
            .flat()
            .toSorted((a, b) => b.at - a.at || b.sequence - a.sequence);
          return listedArtifacts(messages);
        }).pipe(Effect.mapError(refuse)),
      ReadImage: ({ path }) => workspace.readImage(path).pipe(Effect.mapError(refuse)),
      ListFiles: ({ root, dir }) => files.list(root, dir).pipe(Effect.mapError(refuse)),
      FileStatuses: ({ root }) => files.statuses(root).pipe(Effect.mapError(refuse)),
      ReadFile: ({ root, path }) => files.read(root, path).pipe(Effect.mapError(refuse)),
      ReadFileBytes: ({ root, path }) => files.readBytes(root, path).pipe(Stream.mapError(refuse)),
      DiffFile: ({ root, path, from, context }) =>
        files.diff(root, path, from, context).pipe(Effect.mapError(refuse)),
      CommitHistory: ({ root, query, offset, limit }) =>
        history
          .commits(root, {
            ...(query === undefined ? {} : { query }),
            offset: offset ?? 0,
            limit: limit ?? COMMIT_PAGE,
          })
          .pipe(Effect.mapError(refuse)),
      CommitDetail: ({ root, sha }) => history.detail(root, sha).pipe(Effect.mapError(refuse)),
      TurnDiffFile: ({ root, before, after, path, context }) =>
        !isSnapshot(before) || !isSnapshot(after) || resolveInside(root, path) === undefined
          ? Effect.fail(new CeriumError({ message: "That isn't a file a turn changed." }))
          : checkpoints.diff(root, before, after, path, context ?? 3).pipe(
              Effect.map((stdout) => fileDiffOf(stdout, false)),
              Effect.mapError((error) => new CeriumError({ message: error.message })),
            ),
      CommitDiffFile: ({ root, sha, path, from, context }) =>
        history.diff(root, sha, path, from, context).pipe(Effect.mapError(refuse)),
      CloneRepository: ({ url, folder }) => repositories.clone(url, folder).pipe(Stream.mapError(refuse)),
      InitRepository: ({ root }) => repositories.init(root).pipe(Effect.mapError(refuse)),
      WatchFiles: ({ root }) => files.watch(root).pipe(Stream.mapError(refuse)),
      ListProjects: () => projects.list.pipe(Effect.mapError(refuse)),
      SaveProject: ({ path }) => projects.save(path).pipe(Effect.mapError(refuse)),
      RemoveProject: ({ path }) => projects.remove(path).pipe(Effect.mapError(refuse)),
      GitBranch: ({ cwd }) => projects.branch(cwd).pipe(Effect.map((branch) => (branch ? { branch } : {}))),
      ProjectIcon: ({ cwd }) => projects.icon(cwd).pipe(Effect.map((icon) => (icon ? { icon } : {}))),
      Settings: () => settings.get,
      UpdateSettings: (patch) => settings.update(patch).pipe(Effect.mapError(refuse)),
      EffortRouterStatus: () => effortRouter.status.pipe(Effect.mapError(refuseDecision)),
      RemoveEffortRouterKey: () => effortRouter.remove.pipe(Effect.mapError(refuseDecision)),
      ...terminalHandlers(terminals),
      ...gitBranchHandlers(gitBranches),
      ...gitChangesHandlers(gitChanges, drafts),
      ...githubHandlers(github, drafts),
      GitHubStatus: () =>
        github.status.pipe(
          Effect.flatMap((status): Effect.Effect<GitHubStatus> =>
            status._tag === "GhMissing"
              ? Effect.succeed(status)
              : releases.latest({ github: "cli/cli" }).pipe(
                  Effect.map((latest) => {
                    const newer = newerRelease(status.version, Option.getOrUndefined(latest));
                    return {
                      ...status,
                      versionStatus: "supported" as const,
                      ...(newer === undefined ? {} : { latestVersion: newer }),
                    };
                  }),
                ),
          ),
        ),
      ...issueHandlers(github, drafts),
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

/**
 * What this machine answers its own UI about itself: its account, the account's threads, its work
 * and what its threads need the user for.
 */
const DeviceHandlers = deviceHandlers({
  working,
  notifications: Effect.gen(function* () {
    return (yield* Notifications).told;
  }),
  saveEffortRouterKey: Effect.gen(function* () {
    const router = yield* EffortRouter;
    return (key: string) => router.save(key).pipe(Effect.mapError(refuseDecision));
  }),
});

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
