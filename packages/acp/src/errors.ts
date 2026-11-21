import type { HarnessFailure, HarnessUnavailable } from "@cerium/harness";
import { Schema } from "effect";

/** JSON-RPC's and ACP's error codes Cerium acts on. */
export const ErrorCode = {
  /** ACP's `auth_required`: the agent needs a login before it can open or run a session. */
  authRequired: -32000,
  methodNotFound: -32601,
  internal: -32603,
} as const;

/** An error response from the agent, as JSON-RPC carries it. */
export class AcpError extends Schema.TaggedError<AcpError>()("AcpError", {
  code: Schema.Finite,
  message: Schema.String,
}) {}

/** Whether the agent refused because the CLI is signed out. */
export const needsLogin = (error: AcpError | HarnessFailure | HarnessUnavailable) =>
  error._tag === "AcpError" && error.code === ErrorCode.authRequired;
