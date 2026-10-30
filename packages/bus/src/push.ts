import { OrchestratorError } from "@cerium/orchestrator";
import type { AgentId } from "@cerium/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { Tool } from "effect/ai";

// `push`: git push through Cerium, so the user follows the push and its CI checks in the thread
// instead of on GitHub. The backend runs it (apps/backend/src/pushes.ts); the bus only carries it.

export const PushRequest = Schema.Struct({
  expectedHead: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "Refuse if the branch moved since the revision you reviewed.",
  }),
  followCi: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Also follow this pushed commit's CI (default false). PR monitoring is independent: use watch_pull_request.",
  }),
  remote: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "The remote to push to; default the branch's upstream remote, else origin.",
  }),
  branch: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "The local branch to push, to the same name there; default the current branch.",
  }),
});
export type PushRequest = typeof PushRequest.Type;

export const PushAnswer = Schema.Struct({
  /**
   * `pushed`, `rejected` (the remote moved: rebase and push again), `failed` (the pre-push checks or
   * git), `checking` (the checks still run: the outcome arrives as a message), or `denied`.
   */
  status: Schema.Literals(["pushed", "rejected", "failed", "checking", "denied"]),
  pushId: Schema.optionalKey(Schema.String),
  note: Schema.String,
});
export type PushAnswer = typeof PushAnswer.Type;

export const Push = Tool.make("push", {
  description:
    "Push your commits with git, the way `git push` would, pre-push hook and all, and show the user the" +
    " push in the thread. Returns promptly with pushId while the hook and push continue; the outcome" +
    " follows as a message. Inspect workspace_status before pushing and pass expectedHead to bind the" +
    " push to your reviewed revision. PR monitoring is independent: use watch_pull_request. No force" +
    " pushes, and the hook always runs.",
  parameters: PushRequest,
  success: PushAnswer,
  failure: OrchestratorError,
});

/** What runs an agent's push: the backend, with git and GitHub behind it. */
export class PushHost extends Context.Service<
  PushHost,
  {
    readonly push: (agentId: AgentId, request: PushRequest) => Effect.Effect<PushAnswer, OrchestratorError>;
  }
>()("cerium/bus/PushHost") {
  /** For a bus with no backend behind it, such as in tests. */
  static readonly unavailable = Layer.succeed(
    PushHost,
    PushHost.of({
      push: () =>
        Effect.fail(
          new OrchestratorError({ reason: "unavailable", message: "Pushing isn't available here." }),
        ),
    }),
  );
}
