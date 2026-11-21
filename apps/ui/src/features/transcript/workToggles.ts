import { Atom } from "effect/reactivity";

/** A bulk choice is a new scope, even when repeating the same choice. */
export interface WorkedChoice {
  readonly open: boolean;
}

export const workedChoiceAtom = Atom.family((_threadId: string) =>
  Atom.make<WorkedChoice | undefined>(undefined),
);

export const isWorkOpen = (individual: boolean | undefined, bulk: WorkedChoice | undefined, live: boolean) =>
  individual ?? (live || bulk?.open === true);
