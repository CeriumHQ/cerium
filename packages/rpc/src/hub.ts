import {
  HubCopyOutcome,
  HubHarness,
  HubScope,
  HubServerStatus,
  HubTargetScope,
  ProviderId,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// The MCP and skills hub (Settings → MCP & skills): every harness's MCP servers and skills for a
// project, read from and written to the harness's own config. The backend finds a server or skill
// afresh by its name and scope on each change, so nothing the UI sends back carries a secret.

/** A server, by what names it within a harness's config. */
const ServerRef = {
  provider: ProviderId,
  project: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  scope: HubScope,
};

/** Where a copy goes. */
export const HubCopyTarget = Schema.Struct({ provider: ProviderId, scope: HubTargetScope });
export type HubCopyTarget = typeof HubCopyTarget.Type;

export const HubRpcs = RpcGroup.make(
  /** Each harness's servers and skills for `project`, read from its config. Since `RPC_VERSION` 41. */
  Rpc.make("ReadHub", {
    payload: { project: Schema.NonEmptyString },
    success: Schema.Array(HubHarness),
    error: CeriumError,
  }),
  /**
   * A harness's servers as it reports them right now, connecting each: slower than `ReadHub`, so the
   * UI asks once the list shows. Since `RPC_VERSION` 41.
   */
  Rpc.make("ReadHubStatus", {
    payload: { provider: ProviderId, project: Schema.NonEmptyString },
    success: Schema.Array(HubServerStatus),
    error: CeriumError,
  }),
  /** Turns a server on or off where its harness can. Since `RPC_VERSION` 41. */
  Rpc.make("SetHubServer", {
    payload: { ...ServerRef, enabled: Schema.Boolean },
    error: CeriumError,
  }),
  /** Turns one of a server's tools on or off where its harness can. Since `RPC_VERSION` 41. */
  Rpc.make("SetHubTool", {
    payload: { ...ServerRef, tool: Schema.NonEmptyString, enabled: Schema.Boolean },
    error: CeriumError,
  }),
  /** Turns a skill, by its folder, on or off where its harness can. Since `RPC_VERSION` 41. */
  Rpc.make("SetHubSkill", {
    payload: {
      provider: ProviderId,
      project: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      enabled: Schema.Boolean,
    },
    error: CeriumError,
  }),
  /**
   * Copies a server into other harnesses' config, in each one's format, with its environment variables
   * and headers left empty for the user to fill in. Since `RPC_VERSION` 41.
   */
  Rpc.make("CopyHubServer", {
    payload: { ...ServerRef, to: Schema.Array(HubCopyTarget) },
    success: Schema.Array(HubCopyOutcome),
    error: CeriumError,
  }),
  /** Copies a skill's folder into other harnesses' skill folders. Since `RPC_VERSION` 41. */
  Rpc.make("CopyHubSkill", {
    payload: {
      provider: ProviderId,
      project: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      to: Schema.Array(HubCopyTarget),
    },
    success: Schema.Array(HubCopyOutcome),
    error: CeriumError,
  }),
);
