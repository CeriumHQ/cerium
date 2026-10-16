import { Schema } from "effect";

/** A request the orchestrator refused. `message` is written for the agent or user who made it. */
export class OrchestratorError extends Schema.TaggedError<OrchestratorError>()("OrchestratorError", {
  reason: Schema.Literals(["notFound", "notAllowed", "budgetExceeded", "unavailable", "invalid"]),
  message: Schema.String,
}) {}

export const notFound = (message: string) => new OrchestratorError({ reason: "notFound", message });
export const notAllowed = (message: string) => new OrchestratorError({ reason: "notAllowed", message });
