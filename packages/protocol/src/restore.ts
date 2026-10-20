import { Schema } from "effect";

import { AgentId, NonNegativeInt } from "./ids.ts";

// Going back to before one of the user's messages: what it undoes, told before it happens.

/** One file a restore changes, and how: an edit undone, a new file removed, or a deleted one back. */
export const RestoredFile = Schema.Struct({
  /** Relative to the thread's folder, with forward slashes. */
  path: Schema.NonEmptyString,
  undo: Schema.Literals(["edit", "create", "delete"]),
});
export type RestoredFile = typeof RestoredFile.Type;

/** A file the thread changed that another thread in the same folder changed too, which a restore leaves. */
export const KeptFile = Schema.Struct({
  path: Schema.NonEmptyString,
  /** The title of the other thread. */
  thread: Schema.String,
});
export type KeptFile = typeof KeptFile.Type;

/** What restoring a thread to before one of the user's messages would undo. */
export const RestorePreview = Schema.Struct({
  messageId: Schema.NonEmptyString,
  /** The user's messages that go: this one and every one sent after it. */
  messages: NonNegativeInt,
  /**
   * How the lead's conversation goes back: `fork`, its harness's own copy of the session ending
   * before the message; `fresh`, a new session, as nothing came before it; `replay`, a new session told
   * the conversation so far, where the harness can't copy one.
   */
  conversation: Schema.Literals(["fork", "fresh", "replay"]),
  /** The agents the lead spawned that stop: their sessions can't go back. */
  agents: Schema.Array(
    Schema.Struct({ id: AgentId, role: Schema.NonEmptyString, model: Schema.NonEmptyString }),
  ),
  /**
   * What becomes of the files: absent for a chat, which changes none. `unavailable` says why they stay
   * as they are, such as no snapshot having been taken before the message.
   */
  files: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        restored: Schema.Array(RestoredFile),
        kept: Schema.Array(KeptFile),
      }),
      Schema.Struct({ unavailable: Schema.String }),
    ]),
  ),
});
export type RestorePreview = typeof RestorePreview.Type;
