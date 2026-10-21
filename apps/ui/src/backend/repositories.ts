import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Backend } from "./client.ts";

// Making a repository on the machine the window drives: cloning one into a folder the user picks, and
// running `git init` in a folder that isn't one yet.

/**
 * A clone, keyed by its address, folder and an attempt number (`url\nfolder\nattempt`): it runs while
 * something reads it, so letting go of it stops the clone. Its value is git's latest progress, and the
 * last one names the folder made.
 */
export const cloneAtom = Atom.family((attempt: string) => {
  const [url = "", folder = ""] = attempt.split("\n");
  return Backend.runtime.atom(
    Stream.unwrap(Backend.use((client) => Effect.succeed(client("CloneRepository", { url, folder })))),
  );
});

/** Makes a folder a git repository. */
export const initRepository = Backend.mutation("InitRepository");
