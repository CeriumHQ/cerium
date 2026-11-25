import {
  WorkspaceDataHost,
  type ReadThreadResult,
  type WorkspaceIssue,
  type WorkspaceProjectSummary,
  type WorkspacePullRequest,
} from "@cerium/bus";
import { OrchestratorError } from "@cerium/orchestrator";
import { LEAD_ROLE, type AgentEvent, type ProjectInfo } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Effect, Layer, Option, Result } from "effect";

import { GitHub } from "./github.ts";
import { issues } from "./githubIssues.ts";
import { pullRequests } from "./githubPulls.ts";
import { Projects } from "./project.ts";

const baseName = (folder: string): string => folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;

const MAX_EXCERPT = 1_600;
const clip = (text: string): string => (text.length <= MAX_EXCERPT ? text : `${text.slice(0, MAX_EXCERPT)}…`);

const matchesProject = (project: ProjectInfo, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const name = baseName(project.path).toLowerCase();
  const full = project.path.toLowerCase();
  return full === needle || name === needle || full.endsWith(`/${needle}`) || full.endsWith(`\\${needle}`);
};

const extractMessages = (
  events: ReadonlyArray<AgentEvent>,
): Array<{ readonly role: "user" | "assistant"; readonly text: string; readonly at: number }> => {
  const result: Array<{ readonly role: "user" | "assistant"; readonly text: string; readonly at: number }> =
    [];
  for (const event of events) {
    if (event.payload._tag === "TurnInput") {
      const userParts = event.payload.items
        .flatMap((item) => (item._tag === "FromUser" ? [item.text.trim()] : []))
        .filter((part) => part !== "");
      if (userParts.length > 0) {
        result.push({ role: "user", text: clip(userParts.join("\n\n")), at: event.at });
      }
    } else if (event.payload._tag === "MessageCompleted") {
      const text = event.payload.text.trim();
      if (text !== "") {
        result.push({ role: "assistant", text: clip(text), at: event.at });
      }
    }
  }
  return result;
};

/**
 * Provides workspace-wide read-only data (saved projects, thread transcripts, GitHub PRs and issues)
 * to the Cerium MCP bus so Chat leads can answer cross-project questions.
 */
export const WorkspaceDataLive = Layer.effect(
  WorkspaceDataHost,
  Effect.gen(function* () {
    const projects = yield* Projects;
    const github = yield* GitHub;
    const store = yield* Store;
    const prs = pullRequests(github);
    const repoIssues = issues(github);

    const resolveProjects = (filter?: string) =>
      Effect.gen(function* () {
        const listed = yield* projects.list.pipe(
          Effect.mapError(
            (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
          ),
        );
        const live = listed.filter((project) => project.missing !== true);
        if (filter === undefined || filter.trim() === "") return live;
        const matched = live.filter((project) => matchesProject(project, filter));
        if (matched.length > 0) return matched;
        // Also allow passing an explicit folder path directly if not saved in Projects yet.
        if (filter.includes("/") || filter.includes("\\")) {
          return [{ path: filter, usedAt: Date.now() } satisfies ProjectInfo];
        }
        return [];
      });

    const repoName = (cwd: string) =>
      github.repository(cwd).pipe(
        Effect.map((repo) => `${repo.owner}/${repo.name}`),
        Effect.option,
        Effect.map(Option.getOrUndefined),
      );

    return WorkspaceDataHost.of({
      listProjects: Effect.fn("WorkspaceData.listProjects")(function* () {
        const listed = yield* projects.list.pipe(
          Effect.mapError(
            (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
          ),
        );
        return yield* Effect.forEach(
          listed,
          (project) =>
            Effect.gen(function* () {
              const name = baseName(project.path);
              if (project.missing === true) {
                return { name, path: project.path, missing: true } satisfies WorkspaceProjectSummary;
              }
              const [branch, repository] = yield* Effect.all(
                [projects.branch(project.path), repoName(project.path)],
                { concurrency: 2 },
              );
              return {
                name,
                path: project.path,
                ...(branch === undefined ? {} : { branch }),
                ...(repository === undefined ? {} : { repository }),
              } satisfies WorkspaceProjectSummary;
            }),
          { concurrency: 6 },
        );
      }),

      listPullRequests: Effect.fn("WorkspaceData.listPullRequests")(function* (params) {
        const targets = yield* resolveProjects(params.project);
        const limit = Math.min(50, Math.max(1, params.limit ?? 20));
        const seenRepos = new Set<string>();
        const found: Array<WorkspacePullRequest> = [];
        const errors: Array<{ readonly project: string; readonly message: string }> = [];

        yield* Effect.forEach(
          targets,
          (project) =>
            Effect.gen(function* () {
              const name = baseName(project.path);
              const repo = yield* Effect.result(github.repository(project.path));
              if (Result.isFailure(repo)) {
                if (repo.failure.reason !== "noRepository" || params.project !== undefined) {
                  errors.push({ project: name, message: repo.failure.message });
                }
                return;
              }
              const fullName = `${repo.success.owner}/${repo.success.name}`;
              if (seenRepos.has(fullName.toLowerCase())) return;
              seenRepos.add(fullName.toLowerCase());
              const page = yield* Effect.result(
                prs.list(project.path, {
                  ...(params.state === undefined ? {} : { state: params.state }),
                  ...(params.createdByMe === undefined ? {} : { createdByMe: params.createdByMe }),
                  ...(params.reviewRequested === undefined
                    ? {}
                    : { reviewRequested: params.reviewRequested }),
                  ...(params.assignedToMe === undefined ? {} : { assignedToMe: params.assignedToMe }),
                  ...(params.search === undefined ? {} : { search: params.search }),
                }),
              );
              if (Result.isFailure(page)) {
                errors.push({ project: name, message: page.failure.message });
                return;
              }
              for (const pr of page.success.pullRequests) {
                found.push({
                  project: name,
                  projectPath: project.path,
                  repository: fullName,
                  number: pr.number,
                  title: pr.title,
                  state: pr.state,
                  draft: pr.draft,
                  url: pr.url,
                  ...(pr.author?.login ? { author: pr.author.login } : {}),
                  head: pr.head,
                  base: pr.base,
                  updatedAt: pr.updatedAt,
                  comments: pr.comments,
                  labels: pr.labels.map((label) => label.name),
                  ...(pr.reviewDecision === undefined ? {} : { reviewDecision: pr.reviewDecision }),
                  ...(pr.checks === undefined ? {} : { checks: pr.checks }),
                  mergeable: pr.mergeable,
                });
              }
            }),
          { concurrency: 4 },
        );

        const sorted = found.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
        return {
          pullRequests: sorted,
          ...(errors.length === 0 ? {} : { errors }),
        };
      }),

      listIssues: Effect.fn("WorkspaceData.listIssues")(function* (params) {
        const targets = yield* resolveProjects(params.project);
        const limit = Math.min(50, Math.max(1, params.limit ?? 20));
        const seenRepos = new Set<string>();
        const found: Array<WorkspaceIssue> = [];
        const errors: Array<{ readonly project: string; readonly message: string }> = [];

        yield* Effect.forEach(
          targets,
          (project) =>
            Effect.gen(function* () {
              const name = baseName(project.path);
              const repo = yield* Effect.result(github.repository(project.path));
              if (Result.isFailure(repo)) {
                if (repo.failure.reason !== "noRepository" || params.project !== undefined) {
                  errors.push({ project: name, message: repo.failure.message });
                }
                return;
              }
              if (!repo.success.hasIssues) return;
              const fullName = `${repo.success.owner}/${repo.success.name}`;
              if (seenRepos.has(fullName.toLowerCase())) return;
              seenRepos.add(fullName.toLowerCase());
              const page = yield* Effect.result(
                repoIssues.list(project.path, {
                  ...(params.state === undefined ? {} : { state: params.state }),
                  ...(params.assignedToMe === undefined ? {} : { assignedToMe: params.assignedToMe }),
                  ...(params.createdByMe === undefined ? {} : { createdByMe: params.createdByMe }),
                  ...(params.mentioningMe === undefined ? {} : { mentioningMe: params.mentioningMe }),
                  ...(params.labels === undefined ? {} : { labels: params.labels }),
                  ...(params.search === undefined ? {} : { search: params.search }),
                }),
              );
              if (Result.isFailure(page)) {
                errors.push({ project: name, message: page.failure.message });
                return;
              }
              for (const issue of page.success.issues) {
                found.push({
                  project: name,
                  projectPath: project.path,
                  repository: fullName,
                  number: issue.number,
                  title: issue.title,
                  state: issue.state,
                  url: issue.url,
                  ...(issue.author?.login ? { author: issue.author.login } : {}),
                  updatedAt: issue.updatedAt,
                  comments: issue.comments,
                  labels: issue.labels.map((label) => label.name),
                  assignees: issue.assignees.map((assignee) => assignee.login),
                  ...(issue.milestone === undefined ? {} : { milestone: issue.milestone }),
                });
              }
            }),
          { concurrency: 4 },
        );

        const sorted = found.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
        return {
          issues: sorted,
          ...(errors.length === 0 ? {} : { errors }),
        };
      }),

      readThread: Effect.fn("WorkspaceData.readThread")(function* (params) {
        const threadOpt = yield* store
          .getThread(params.threadId)
          .pipe(
            Effect.mapError(
              (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
            ),
          );
        if (Option.isNone(threadOpt)) {
          return yield* new OrchestratorError({
            reason: "notFound",
            message: `Thread ${params.threadId} was not found.`,
          });
        }
        const thread = threadOpt.value;
        const agents = yield* store
          .listAgents(thread.id)
          .pipe(
            Effect.mapError(
              (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
            ),
          );
        const lead =
          agents.find((agent) => agent.parentId === undefined && agent.role === LEAD_ROLE) ?? agents[0];
        const limit = Math.min(30, Math.max(1, params.limit ?? 12));
        const allMessages =
          lead === undefined
            ? []
            : extractMessages(
                yield* store
                  .listEvents(lead.id, { tags: ["TurnInput", "MessageCompleted"] })
                  .pipe(
                    Effect.mapError(
                      (error) => new OrchestratorError({ reason: "unavailable", message: error.message }),
                    ),
                  ),
              );
        return {
          threadId: thread.id,
          title: thread.title,
          mode: thread.mode,
          ...(thread.cwd === undefined ? {} : { folder: thread.cwd }),
          updatedAt: thread.updatedAt,
          archived: thread.archivedAt !== undefined,
          totalMessages: allMessages.length,
          messages: allMessages.slice(-limit),
        } satisfies ReadThreadResult;
      }),
    });
  }),
);
