import type { AccountState, ThreadRef } from "@cerium/protocol";
import { useAtomSet } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { reportPresence } from "../../backend/atoms.ts";
import { shellBridge } from "../../backend/shell.ts";
import { Notice } from "../../app/Notice.tsx";

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};

/**
 * Whether the user is at the desktop app: one of its windows focused, and the computer neither idle
 * nor locked. A window left open on a desk would otherwise keep their phone quiet. Always in a browser,
 * where being on screen says enough.
 */
function useAttended() {
  const [attended, setAttended] = useState(true);
  useEffect(() => shellBridge()?.onAttendedChange?.(setAttended), []);
  return attended;
}

/**
 * Tells the account what this window shows: whether it's on screen and the user is at it,
 * and the thread open in it, so nobody is notified about what they're looking at.
 */
export function useAccountPresence(account: AccountState, viewing: ThreadRef | undefined) {
  const report = useAtomSet(reportPresence, { mode: "promise" });
  const onScreen = useSyncExternalStore(onVisibility, () => document.visibilityState === "visible");
  const attended = useAttended();
  const visible = onScreen && attended;
  const signedIn = account._tag === "SignedIn";
  const machine = viewing?.machine;
  const threadId = viewing?.threadId;
  const send = useEffectEvent(() => {
    const payload = machine && threadId ? { visible, viewing: { machine, threadId } } : { visible };
    void report({ payload }).catch(() => undefined);
  });
  useEffect(() => {
    if (signedIn) send();
  }, [signedIn, visible, machine, threadId]);
}

const linkClass =
  "font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary";

/**
 * The machine the window drives has stopped answering: the window keeps trying, and says so once
 * here, with the way back to this computer when there is one.
 */
export function UnreachableNotice({
  machine,
  presence,
  onBack,
}: {
  machine: string;
  /** Since when it's been offline, such as "Last seen 3 hours ago", when the relay knows. */
  presence?: string | undefined;
  /** Drives this computer again; none in the web client, which picks from the menu. */
  onBack?: (() => void) | undefined;
}) {
  return (
    <Notice tone="attention">
      {presence === undefined
        ? `Can't reach ${machine}.`
        : `${machine} is offline (${presence.toLowerCase()}).`}
      {onBack ? (
        <>
          {" "}
          <button type="button" onClick={onBack} className={linkClass}>
            Back to this computer
          </button>
        </>
      ) : null}
    </Notice>
  );
}
