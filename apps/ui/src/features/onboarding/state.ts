import { AsyncResult, Atom } from "effect/reactivity";

import { threadsAtom } from "../../backend/atoms.ts";
import { WEB } from "../../backend/target.ts";

/** Asks for the welcome again: the command palette and Settings → General set it, and finishing it clears it. */
export const welcomeOpenAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * Whether the welcome is on screen, over the window: what the window would open by itself (What's new)
 * waits for it, and the message box takes the cursor back once it's gone.
 */
export const welcomeShownAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * How many threads this computer lists, which decides whether the welcome opens on launch; undefined
 * until it answers. The web client never asks: it opens no welcome.
 */
export const threadCountAtom = Atom.make((get): number | undefined => {
  if (WEB) return undefined;
  const threads = get(threadsAtom);
  return AsyncResult.isSuccess(threads) ? threads.value.length : undefined;
});
