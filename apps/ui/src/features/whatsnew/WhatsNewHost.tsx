import { useAtom } from "@effect/atom-react";
import { useEffect } from "react";

import { remember, stored } from "../../lib/storage.ts";
import { useUpdates } from "../updates/useUpdates.ts";
import { LAST_SEEN_KEY, opensAfterUpdate } from "./model.ts";
import { whatsNewOpenAtom } from "./state.ts";
import { WhatsNew } from "./WhatsNew.tsx";

/**
 * Owns the What's new panel: it opens by itself the first time a window runs a build other than
 * the one it last ran, and whenever `whatsNewOpenAtom` is set.
 */
export function WhatsNewHost() {
  const [open, setOpen] = useAtom(whatsNewOpenAtom);
  const version = useUpdates()?.version;
  useEffect(() => {
    if (version === undefined) return;
    if (opensAfterUpdate(stored(LAST_SEEN_KEY), version)) setOpen(true);
    remember(LAST_SEEN_KEY, version);
  }, [version, setOpen]);
  return <WhatsNew open={open} onOpenChange={setOpen} />;
}
