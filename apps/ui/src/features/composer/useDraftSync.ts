import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";

import { accountDraftsAtom, saveDrafts } from "../../backend/atoms.ts";
import { draftsAtom, readStamps, writeStamps } from "./drafts.ts";
import { applyTaken, draftBatches, reconcileDrafts } from "./draftSync.ts";

/** How long writing pauses before the latest edit goes to the account's other devices. */
const SEND_AFTER_MS = 600;

/**
 * Keeps the window's drafts in step with the account's other devices while signed in. `here` names
 * this computer in drafts of new threads it starts; none in the web client.
 */
export function useDraftSync(signedIn: boolean, here: string | undefined) {
  const registry = useContext(RegistryContext);
  const cloud = AsyncResult.getOrElse(useAtomValue(accountDraftsAtom), () => undefined);
  const drafts = useAtomValue(draftsAtom);
  const save = useAtomSet(saveDrafts, { mode: "promise" });
  const ready = signedIn && cloud?.ready === true;

  const sync = useEffectEvent(() => {
    if (!ready || cloud === undefined) return;
    const { take, send } = reconcileDrafts(registry.get(draftsAtom), readStamps(), cloud.drafts, here);
    if (take.length > 0) {
      // Stamped first, so the drafts' own writer sees nothing of its own to stamp.
      writeStamps({ ...readStamps(), ...Object.fromEntries(take.map(({ key, stamp }) => [key, stamp])) });
      registry.set(draftsAtom, applyTaken(registry.get(draftsAtom), take));
    }
    // Unsent, a draft goes the next time the cloud's drafts or this window's change.
    for (const batch of draftBatches(send)) void save({ payload: { drafts: batch } }).catch(() => undefined);
  });

  // What the cloud says is taken at once; what's written here goes once writing pauses.
  useEffect(() => sync(), [ready, cloud]);
  useEffect(() => {
    const timer = setTimeout(sync, SEND_AFTER_MS);
    return () => clearTimeout(timer);
  }, [drafts]);
}
