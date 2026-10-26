import { OrchestratorError } from "@cerium/orchestrator";
import type { AgentId } from "@cerium/protocol";
import { Context, Effect, Layer, Schema } from "effect";
import { Tool } from "effect/ai";

// `push`: git push through Cerium, so the user follows the push and its CI checks in the thread
// instead of on GitHub. The backend runs it (apps/backend/src/pushes.ts); the bus only carries it.

export const PushRequest = Schema.Struct({
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
    " push and its CI checks in the thread. Use it instead of running `git push` yourself. It returns" +
    " once the push lands or fails, or after about 45 seconds while the pre-push checks still run, when" +
    " the outcome follows as a message. The CI result reaches you later as a message too: the failing" +
    " check and its log's last lines when CI fails, so you can fix it. No force pushes, and the hook" +
    " always runs.",
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
