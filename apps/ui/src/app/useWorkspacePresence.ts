import { type DeviceId } from "@cerium/protocol";

import { useAccountPresence } from "../features/account/AccountNotice.tsx";
import { type ThreadSummary } from "../features/threads/model.ts";
import { useDesktopNotifications } from "../desktop/notifications.ts";
import { useNotificationOpens, useRenewPush } from "../web/push.ts";

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
  const { account, summaries, viewed, drivenId, cloudSelected, thisComputer } = threads;
  // A tapped notification opens its thread, once the inbox lists it.
  useNotificationOpens((threadId) => summaries.find((summary) => summary.id === threadId), openSummary);
  useRenewPush(account);
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
