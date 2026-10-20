import type { ThreadNotification } from "@cerium/protocol";
import { CeriumError, DeviceRpcs } from "@cerium/rpc";
import { Effect, type Stream } from "effect";

import { Account, type AccountError } from "./account.ts";
import { CloudThreads } from "./cloud.ts";

// The device RPCs, as a desktop's backend serves them to its UI and as the web client answers them
// inside the page.

const refuse = (error: AccountError) => new CeriumError({ message: error.message });

/**
 * The handlers of `DeviceRpcs`. `working` says whether this device's own agents are working, and
 * `notifications` tells what its threads need the user for; a browser has neither. Requires
 * `Account` and `CloudThreads`.
 */
export const deviceHandlers = <W, N>(own: {
  readonly working: Effect.Effect<Stream.Stream<boolean>, never, W>;
  readonly notifications: Effect.Effect<Stream.Stream<ThreadNotification>, never, N>;
}) =>
  DeviceRpcs.toLayer(
    Effect.gen(function* () {
      const account = yield* Account;
      const cloud = yield* CloudThreads;
      const workingNow = yield* own.working;
      const notifications = yield* own.notifications;
      return DeviceRpcs.of({
        WatchAccount: () => account.changes,
        SignIn: () => account.signIn.pipe(Effect.mapError(refuse)),
        CancelSignIn: () => account.cancelSignIn,
        SignOut: () => account.signOut.pipe(Effect.mapError(refuse)),
        ApproveDevice: ({ deviceId }) => account.approve(deviceId).pipe(Effect.mapError(refuse)),
        RenameDevice: ({ deviceId, name }) => account.rename(deviceId, name).pipe(Effect.mapError(refuse)),
        RemoveDevice: ({ deviceId }) => account.remove(deviceId).pipe(Effect.mapError(refuse)),
        WatchAccountThreads: () => cloud.accountThreads,
        CloudThreadEvents: ({ machine, threadId }) =>
          cloud.cloudEvents(machine, threadId).pipe(Effect.mapError(refuse)),
        MarkThreadsRead: ({ entries }) => cloud.markRead(entries).pipe(Effect.mapError(refuse)),
        WatchAccountDrafts: () => cloud.accountDrafts,
        SaveDrafts: ({ drafts }) => cloud.saveDrafts(drafts).pipe(Effect.mapError(refuse)),
        WatchWorking: () => workingNow,
        ReportPresence: (presence) => account.reportPresence(presence),
        SubscribePush: ({ subscription, kinds }) =>
          account.send({ _tag: "PushSubscribe", subscription, kinds }).pipe(Effect.mapError(refuse)),
        UnsubscribePush: () => account.send({ _tag: "PushUnsubscribe" }).pipe(Effect.mapError(refuse)),
        WatchNotifications: () => notifications,
      });
    }),
  );
