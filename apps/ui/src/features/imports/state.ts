import { Atom } from "effect/reactivity";

/** Opens the dialog that brings the user's own harness sessions in; the command palette sets it. */
export const importOpenAtom = Atom.make(false).pipe(Atom.keepAlive);
