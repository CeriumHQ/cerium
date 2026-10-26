import { AccessMode, EpochMillis, PastSession, ThreadInfo } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// Bringing the user's own harness sessions into Cerium, from the welcome or the command palette.

export const ImportRpcs = RpcGroup.make(
  /**
   * The user's sessions with each signed-in harness that lists them, newest first, less those a
   * thread already holds. Since `RPC_VERSION` 30.
   */
  Rpc.make("ListPastSessions", { success: Schema.Array(PastSession), error: CeriumError }),
  /**
   * Brings sessions in as threads whose leads go on with them, and answers the threads made. One a
   * thread already holds is skipped. Since `RPC_VERSION` 30.
   */
  Rpc.make("ImportSessions", {
    payload: {
      sessions: Schema.Array(PastSession),
      /** The access the leads of work threads get; chats stay read-only. */
      access: AccessMode,
      /** Sessions last active before this go straight to Archive. */
      archiveBefore: Schema.optionalKey(EpochMillis),
    },
    success: Schema.Array(ThreadInfo),
    error: CeriumError,
  }),
);
