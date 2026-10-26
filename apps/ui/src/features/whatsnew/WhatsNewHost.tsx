import { useAtom, useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import changelog from "../../../../../CHANGELOG.md?raw";
import { BUILD_VERSION, WEB } from "../../backend/target.ts";
import { remember, stored } from "../../lib/storage.ts";
import { windowCoveredAtom } from "../onboarding/state.ts";
import { opensAfterUpdate, parseChangelog, SEEN_KEY, seenValue, unseenIds } from "./model.ts";
import { whatsNewOpenAtom } from "./state.ts";
import { WhatsNew } from "./WhatsNew.tsx";

const changes = parseChangelog(changelog);

/** How long after the window shows the panel opens: once the launch screen's mark has landed. */
const SETTLE_MS = 900;

/**
 * Owns the What's new panel: it opens by itself when a new build brought changes this computer hasn't
 * shown, once the launch screen and the welcome have given the window over, and whenever
 * `whatsNewOpenAtom` is set. What was new when the window opened stays marked so until it closes.
 */
export function WhatsNewHost() {
  const [open, setOpen] = useAtom(whatsNewOpenAtom);
  const covered = useAtomValue(windowCoveredAtom);
  const [unseen] = useState(() => unseenIds(changes, stored(SEEN_KEY)));
  const offered = useRef(false);
  useEffect(() => {
    if (covered || offered.current) return;
    // A first run only notes what the build holds: it's all simply how Cerium is.
    if (stored(SEEN_KEY) === undefined) remember(SEEN_KEY, seenValue(changes));
    // The web client updates unannounced, as a page does.
    if (WEB || !opensAfterUpdate(unseen.size, BUILD_VERSION)) return;
    // Once only: the welcome opened again later doesn't bring it back.
    const timer = setTimeout(() => {
      offered.current = true;
      setOpen(true);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [covered, unseen, setOpen]);
  useEffect(() => {
    if (open) remember(SEEN_KEY, seenValue(changes));
  }, [open]);
  return (
    <WhatsNew open={open} onOpenChange={setOpen} changes={changes} unseen={unseen} version={BUILD_VERSION} />
  );
}
