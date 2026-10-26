import { Schema } from "effect";

import { EpochMillis, NonNegativeInt, ProviderId } from "./ids.ts";

/**
 * A session the user had with a harness outside Cerium, which Cerium can bring in as a thread whose
 * lead goes on with it. Listed by the harness itself; Cerium reads sessions, never credentials.
 */
export const PastSession = Schema.Struct({
  provider: ProviderId,
  /** The harness's own session id. */
  id: Schema.NonEmptyString,
  /** The folder it ran in; absent when the harness recorded none, and it comes in as a chat. */
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  /** Its title, or its first message when it has none. */
  title: Schema.String,
  createdAt: Schema.optionalKey(EpochMillis),
  /** Its last activity. */
  updatedAt: EpochMillis,
  /** How many turns it holds, when the harness counts them. */
  turns: Schema.optionalKey(NonNegativeInt),
  /** How much the harness keeps of it on disk, when it says. */
  bytes: Schema.optionalKey(NonNegativeInt),
  /** The model it last ran on, when the harness says. */
  model: Schema.optionalKey(Schema.NonEmptyString),
});
export type PastSession = typeof PastSession.Type;

/** How long ago a session's last activity may be for it to come in to the inbox; older ones are archived. */
export const RECENT_SESSION_DAYS = 14;
