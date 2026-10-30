import { OrchestratorError } from "@cerium/orchestrator";
import { SourceControlCommand, SourceControlResult, type AgentId } from "@cerium/protocol";
import { Context, Effect, Schema } from "effect";
import { Tool } from "effect/ai";

export class SourceControlHost extends Context.Service<
  SourceControlHost,
  {
    readonly run: (
      agentId: AgentId,
      command: SourceControlCommand,
    ) => Effect.Effect<SourceControlResult, OrchestratorError>;
  }
>()("cerium/bus/SourceControlHost") {}

const { action: _action, ...parameters } = SourceControlCommand.fields;
const tool = <Name extends string>(name: Name, description: string) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: SourceControlResult,
    failure: OrchestratorError,
  });

export const WorkspaceStatus = tool(
  "workspace_status",
  "Inspect this thread's checkout, live Git state, base, related conversations, linked PRs and next action.",
);
export const ListWorkspaces = tool(
  "list_workspaces",
  "Find this project's existing checkouts and the conversations using each one, including archived context.",
);
export const LinkPullRequest = tool(
  "link_pull_request",
  "Keep a PR URL with this thread and workspace. Linking reads its current state; it does not start monitoring.",
);
export const UnlinkPullRequest = tool(
  "unlink_pull_request",
  "Remove a PR URL from this thread. Other threads' links remain.",
);
export const LinkIssue = tool(
  "link_issue",
  "Keep a GitHub issue URL with this conversation and its workspace.",
);
export const WatchPullRequest = tool(
  "watch_pull_request",
  "Watch a linked PR URL for checks, reviews and conflicts. Changes reach this lead later. End your turn after starting a watch; do not poll. Watching never merges a PR.",
);
export const UnwatchPullRequest = tool(
  "unwatch_pull_request",
  "Stop this thread's watch of a PR URL, retaining its link.",
);
export const ReviewChanges = tool(
  "review_changes",
  "Read a diff scoped to turn, thread, uncommitted changes or branch against its base. Results include the reviewed revision; ambiguous shared-checkout edits are identified.",
);
export const MoveToWorkspace = tool(
  "move_to_workspace",
  "Move this thread to a new or existing checkout using workspace. End your turn after calling: the move waits for the current turn to finish. Uncommitted edits stay in the source checkout; the transcript is retained.",
);
