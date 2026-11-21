import { Schema } from "effect";

/** A request the orchestrator refused. `message` is written for the agent or user who made it. */
export class OrchestratorError extends Schema.TaggedError<OrchestratorError>()("OrchestratorError", {
  reason: Schema.Literals(["notFound", "notAllowed", "budgetExceeded", "unavailable", "invalid"]),
  message: Schema.String,
}) {}

export const notFound = (message: string) => new OrchestratorError({ reason: "notFound", message });
export const notAllowed = (message: string) => new OrchestratorError({ reason: "notAllowed", message });

/** A service the request needed failed: the store, a harness, git or the file system. */
export const unavailable = (error: { readonly message: string }) =>
  new OrchestratorError({ reason: "unavailable", message: error.message });

/** A worktree operation git refused, which the caller can correct. */
export const refusedWorktree = (error: { readonly message: string }) =>
  new OrchestratorError({ reason: "invalid", message: error.message });

/** The harness a request named has no adapter in this build. */
export const noAdapter = (provider: string) =>
  new OrchestratorError({ reason: "unavailable", message: `No ${provider} adapter is installed.` });
