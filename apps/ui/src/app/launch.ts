import { useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

/** Whether the window has what it shows first, so the launch screen can give way; it stays so. */
export const launchedAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Lifts the launch screen once `ready`: whichever part of the window shows first says when. */
export const useLaunched = (ready: boolean) => {
  const setLaunched = useAtomSet(launchedAtom);
  useEffect(() => {
    if (ready) setLaunched(true);
  }, [ready, setLaunched]);
};
