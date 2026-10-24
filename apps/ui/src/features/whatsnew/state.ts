import { Atom } from "effect/reactivity";

/** Whether the What's new panel is open; the command palette and Settings → General set it. */
export const whatsNewOpenAtom = Atom.make(false).pipe(Atom.keepAlive);
