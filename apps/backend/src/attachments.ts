import type { AgentEvent } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Clock, Effect, FileSystem, Path } from "effect";

// Pasted files are saved the moment they are pasted (`Workspace.saveAttachment`), each in a folder
// named by a UUIDv7, so ones removed from the draft or never sent would stay forever. Drafts live
// only in the window, so once a folder is older than any draft can reasonably be and no sent message
// names it, nothing will.

/** How long a pasted file may wait in a draft before an unsent one is removed. */
const UNSENT_GRACE_MS = 24 * 60 * 60 * 1000;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** When a UUIDv7 was made, in epoch milliseconds; undefined for any other name. */
export const uuidv7Time = (name: string): number | undefined =>
  UUID_V7.test(name) ? Number.parseInt(name.slice(0, 8) + name.slice(9, 13), 16) : undefined;

/** Every attachment path the user's sent messages carry. */
export const sentAttachments = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event.payload._tag === "TurnInput"
      ? event.payload.items.flatMap((item) =>
          item._tag === "FromUser" ? (item.attachments ?? []).map((attachment) => attachment.path) : [],
        )
      : [],
  );

/**
 * Removes the folders in `directory` that hold pasted files no sent message names, once they are past
 * the grace period. Anything Cerium didn't name there is left alone.
 */
export const sweepAttachments = Effect.fn("Workspace.sweepAttachments")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* Store;
  if (!(yield* fs.exists(directory))) return;

  // A file sent by its own path lives outside `directory`, so it names no folder here.
  const sent = new Set(
    sentAttachments(yield* store.listEventsByTag("TurnInput")).map(
      (file) => path.relative(directory, file).split(path.sep)[0],
    ),
  );
  const cutoff = (yield* Clock.currentTimeMillis) - UNSENT_GRACE_MS;
  const unsent = (yield* fs.readDirectory(directory)).filter((name) => {
    const madeAt = uuidv7Time(name);
    return madeAt !== undefined && madeAt < cutoff && !sent.has(name);
  });

  yield* Effect.forEach(
    unsent,
    (name) => {
      const folder = path.join(directory, name);
      return fs.stat(folder).pipe(
        Effect.flatMap((info) =>
          info.type === "Directory" ? fs.remove(folder, { recursive: true }) : Effect.void,
        ),
        // Windows refuses to remove a file something still has open; the next launch tries again.
        Effect.ignore({ log: "Warn", message: `Couldn't remove the unsent attachment ${folder}` }),
      );
    },
    { discard: true },
  );
});
