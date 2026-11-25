import { OrchestratorError } from "@cerium/orchestrator";
import { ThreadId, ThreadMode } from "@cerium/protocol";
import { Context, Effect, Schema } from "effect";
import { Tool } from "effect/ai";

export const WorkspaceProjectSummary = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  missing: Schema.optionalKey(Schema.Boolean),
  branch: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
});
export type WorkspaceProjectSummary = typeof WorkspaceProjectSummary.Type;

export const WorkspacePullRequest = Schema.Struct({
  project: Schema.String,
  projectPath: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.Boolean,
  url: Schema.String,
  author: Schema.optionalKey(Schema.String),
  head: Schema.String,
  base: Schema.String,
  updatedAt: Schema.Finite,
  comments: Schema.Int,
  labels: Schema.Array(Schema.String),
  reviewDecision: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.String),
  mergeable: Schema.String,
});
export type WorkspacePullRequest = typeof WorkspacePullRequest.Type;

export const WorkspaceIssue = Schema.Struct({
  project: Schema.String,
  projectPath: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  url: Schema.String,
  author: Schema.optionalKey(Schema.String),
  updatedAt: Schema.Finite,
  comments: Schema.Int,
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  milestone: Schema.optionalKey(Schema.String),
});
export type WorkspaceIssue = typeof WorkspaceIssue.Type;

export const WorkspaceQueryError = Schema.Struct({
  project: Schema.String,
  message: Schema.String,
});

export const ThreadMessageExcerpt = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  at: Schema.Finite,
});

export const ReadThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  mode: ThreadMode,
  folder: Schema.optionalKey(Schema.String),
  updatedAt: Schema.Finite,
  archived: Schema.Boolean,
  totalMessages: Schema.Int,
  messages: Schema.Array(ThreadMessageExcerpt),
});
export type ReadThreadResult = typeof ReadThreadResult.Type;

export const ListPullRequestsParams = Schema.Struct({
  project: Schema.optionalKey(Schema.String).annotate({
    description: "Project name or folder path to query. Leave out to query across all saved GitHub projects.",
  }),
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "merged", "all"])).annotate({
    description: "Filter by state; defaults to open.",
  }),
  createdByMe: Schema.optionalKey(Schema.Boolean),
  reviewRequested: Schema.optionalKey(Schema.Boolean),
  assignedToMe: Schema.optionalKey(Schema.Boolean),
  search: Schema.optionalKey(Schema.String).annotate({
    description: "GitHub search words to narrow titles, bodies, or branches.",
  }),
  limit: Schema.optionalKey(Schema.Int).annotate({
    description: "Maximum pull requests to return (default 20, max 50).",
  }),
});
export type ListPullRequestsParams = typeof ListPullRequestsParams.Type;

export const ListIssuesParams = Schema.Struct({
  project: Schema.optionalKey(Schema.String).annotate({
    description: "Project name or folder path to query. Leave out to query across all saved GitHub projects.",
  }),
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])).annotate({
    description: "Filter by state; defaults to open.",
  }),
  assignedToMe: Schema.optionalKey(Schema.Boolean),
  createdByMe: Schema.optionalKey(Schema.Boolean),
  mentioningMe: Schema.optionalKey(Schema.Boolean),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  search: Schema.optionalKey(Schema.String).annotate({
    description: "GitHub search words to narrow titles, bodies, or comments.",
  }),
  limit: Schema.optionalKey(Schema.Int).annotate({
    description: "Maximum issues to return (default 20, max 50).",
  }),
});
export type ListIssuesParams = typeof ListIssuesParams.Type;

export const ReadThreadParams = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The threadId returned by list_threads." }),
  limit: Schema.optionalKey(Schema.Int).annotate({
    description: "Maximum recent user/assistant messages to return (default 12, max 30).",
  }),
});
export type ReadThreadParams = typeof ReadThreadParams.Type;

/** Backend implementation that supplies workspace-wide projects, threads, PRs, and issues to the bus. */
export class WorkspaceDataHost extends Context.Service<
  WorkspaceDataHost,
  {
    readonly listProjects: () => Effect.Effect<ReadonlyArray<WorkspaceProjectSummary>, OrchestratorError>;
    readonly listPullRequests: (params: ListPullRequestsParams) => Effect.Effect<
      {
        readonly pullRequests: ReadonlyArray<WorkspacePullRequest>;
        readonly errors?: ReadonlyArray<typeof WorkspaceQueryError.Type>;
      },
      OrchestratorError
    >;
    readonly listIssues: (params: ListIssuesParams) => Effect.Effect<
      {
        readonly issues: ReadonlyArray<WorkspaceIssue>;
        readonly errors?: ReadonlyArray<typeof WorkspaceQueryError.Type>;
      },
      OrchestratorError
    >;
    readonly readThread: (params: ReadThreadParams) => Effect.Effect<ReadThreadResult, OrchestratorError>;
  }
>()("cerium/bus/WorkspaceDataHost") {}

export const ListProjects = Tool.make("list_projects", {
  description:
    "List the user's saved projects on this machine, with each project's name, path, current git branch, and GitHub repository (when present).",
  success: Schema.Struct({ projects: Schema.Array(WorkspaceProjectSummary) }),
  failure: OrchestratorError,
});

export const ListPullRequests = Tool.make("list_pull_requests", {
  description:
    "List GitHub pull requests for a saved project or across all saved projects, with state, author, checks, review status, and links.",
  parameters: ListPullRequestsParams,
  success: Schema.Struct({
    pullRequests: Schema.Array(WorkspacePullRequest),
    errors: Schema.optionalKey(Schema.Array(WorkspaceQueryError)),
  }),
  failure: OrchestratorError,
});

export const ListIssues = Tool.make("list_issues", {
  description:
    "List GitHub issues for a saved project or across all saved projects, with state, labels, assignees, author, and links.",
  parameters: ListIssuesParams,
  success: Schema.Struct({
    issues: Schema.Array(WorkspaceIssue),
    errors: Schema.optionalKey(Schema.Array(WorkspaceQueryError)),
  }),
  failure: OrchestratorError,
});

export const ReadThread = Tool.make("read_thread", {
  description:
    "Read the recent user and assistant messages from one of the user's threads (work or chat) by threadId, to summarize progress or check context.",
  parameters: ReadThreadParams,
  success: ReadThreadResult,
  failure: OrchestratorError,
});
