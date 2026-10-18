import type { AccountState, ThreadRef } from "@cerium/protocol";
import { useAtomSet } from "@effect/atom-react";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { reportPresence } from "../../backend/atoms.ts";
import { shellBridge } from "../../backend/shell.ts";
import { Notice } from "../../app/Notice.tsx";
import { waitingDevices } from "./model.ts";

/**
 * Tells the shell whether this machine is signed in and agents are working, which keep it in the
 * tray when its window closes and the PC awake (docs/architecture.md §14.5).
 */
export function useShellPresence(account: AccountState, working: boolean) {
  const signedIn = account._tag === "SignedIn";
  useEffect(() => {
    shellBridge()?.setPresence?.({ signedIn, working });
  }, [signedIn, working]);
}

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};

/**
 * Tells the account what this window shows (docs/architecture.md §14.11): whether it's on screen,
 * and the thread open in it, so nobody is notified about what they're looking at.
 */
export function useAccountPresence(account: AccountState, viewing: ThreadRef | undefined) {
  const report = useAtomSet(reportPresence, { mode: "promise" });
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState === "visible");
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

/** Devices waiting to join the account, wherever the user is, with the way to them. */
export function DeviceRequestNotice({ account, onReview }: { account: AccountState; onReview: () => void }) {
  const waiting = waitingDevices(account);
  if (waiting.length === 0) return null;
  return (
    <Notice tone="attention">
      {waiting.length === 1
        ? `${waiting[0]!.name} wants to join your Cerium account.`
        : `${waiting.length} devices want to join your Cerium account.`}{" "}
      <button
        type="button"
        onClick={onReview}
        className="font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary"
      >
        Review
      </button>
    </Notice>
  );
}
