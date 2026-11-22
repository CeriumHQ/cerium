import { type DeviceId } from "@cerium/protocol";

import { useAccountPresence } from "../features/account/AccountNotice.tsx";
import { type ThreadSummary } from "../features/threads/model.ts";
import { useDesktopNotifications } from "../desktop/notifications.ts";
import { WEB } from "../backend/target.ts";
import { badgeCount, useAppBadge, useNotificationOpens, useRenewPush } from "../web/push.ts";

import type { DrivenMachine } from "../backend/machine.ts";
import type { SoloThread } from "./threadWindow.ts";
import type { WorkspaceThreads } from "./useWorkspaceThreads.ts";

export function useWorkspacePresence({
  driven,
  solo,
  compact,
  settingsOpen,
  pane,
  threads,
  openSummary,
}: {
  readonly driven: DrivenMachine | undefined;
  readonly solo: SoloThread | undefined;
  readonly compact: boolean;
  readonly settingsOpen: boolean;
  readonly pane: "list" | "main";
  readonly threads: WorkspaceThreads;
  readonly openSummary: (summary: ThreadSummary) => void;
}) {
  const { account, summaries, viewed, drivenId, cloudSelected, thisComputer, live } = threads;
  // The web client hears which of the account's computers can be reached once its relay connection
  // is up (or has failed): a tap on another computer's thread waits for that, so it drives that
  // computer rather than opening the thread's cloud copy for want of knowing.
  const devicesKnown = !WEB || (account._tag === "SignedIn" && account.connection !== "connecting");
  // A tapped notification opens its thread on its machine, once the inbox lists it: openSummary
  // drives that machine when it can be reached, and opens its cloud copy when it can't.
  useNotificationOpens(({ threadId, machine }) => {
    if (machine !== undefined && machine !== drivenId && !devicesKnown) return undefined;
    const matching = summaries.filter((summary) => summary.id === threadId);
    return (
      matching.find(
        (summary) => machine === undefined || (summary.elsewhere?.machine ?? drivenId) === machine,
      ) ?? matching[0]
    );
  }, openSummary);
  useRenewPush(account);
  // The installed web app's icon counts what waits on the user, once the threads are known.
  useAppBadge(badgeCount(summaries), live || summaries.length > 0);
  const threadShown = viewed !== undefined && !settingsOpen && (!compact || pane === "main");
  // Nobody is told about the thread this window shows, unless settings or the narrow
  // window's inbox cover it. The account hears it from the main window alone, whose word a thread's
  // own window would otherwise take turns with.
  useAccountPresence(
    solo ? { _tag: "SignedOut" } : account,
    viewed && threadShown && drivenId !== undefined
      ? {
          machine: (cloudSelected?.machine ?? drivenId) as DeviceId,
          threadId: viewed.thread.id,
        }
      : undefined,
  );
  // This computer's own notifications, about any of its threads but the one shown here.
  useDesktopNotifications(
    !solo,
    viewed && threadShown && (cloudSelected ? cloudSelected.machine === thisComputer : driven === undefined)
      ? viewed.thread.id
      : undefined,
  );
}
