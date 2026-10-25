import type { ThreadNotification } from "@cerium/protocol";
import { CeriumError, DeviceRpcs, type EffortRouterStatus } from "@cerium/rpc";
import { Effect, type Stream } from "effect";

import { Account, type AccountError } from "./account.ts";
import { CloudThreads } from "./cloud.ts";

// The device RPCs, as a desktop's backend serves them to its UI and as the web client answers them
// inside the page.

const refuse = (error: AccountError) => new CeriumError({ message: error.message });

/** What saves the effort router's key: a desktop's backend; a browser refuses. */
export type SaveEffortRouterKey = (key: string) => Effect.Effect<EffortRouterStatus, CeriumError>;

/** A browser saves no key: it would reach the machine through the relay, readable there. */
export const refuseEffortRouterKey: SaveEffortRouterKey = () =>
  Effect.fail(
    new CeriumError({ message: "Save the key in the Cerium app on the computer whose agents use it." }),
  );

/**
 * The handlers of `DeviceRpcs`. `working` says whether this device's own agents are working,
 * `notifications` tells what its threads need the user for, and `saveEffortRouterKey` keeps the
 * effort router's key; a browser has none of them. Requires `Account` and `CloudThreads`.
 */
export const deviceHandlers = <W, N, K>(own: {
  readonly working: Effect.Effect<Stream.Stream<boolean>, never, W>;
  readonly notifications: Effect.Effect<Stream.Stream<ThreadNotification>, never, N>;
  readonly saveEffortRouterKey: Effect.Effect<SaveEffortRouterKey, never, K>;
}) =>
  DeviceRpcs.toLayer(
    Effect.gen(function* () {
      const account = yield* Account;
      const cloud = yield* CloudThreads;
      const workingNow = yield* own.working;
      const notifications = yield* own.notifications;
      const saveKey = yield* own.saveEffortRouterKey;
      return DeviceRpcs.of({
        WatchAccount: () => account.changes,
        SignIn: () => account.signIn.pipe(Effect.mapError(refuse)),
        CancelSignIn: () => account.cancelSignIn,
        SignOut: () => account.signOut.pipe(Effect.mapError(refuse)),
        RenameDevice: ({ deviceId, name }) => account.rename(deviceId, name).pipe(Effect.mapError(refuse)),
        RemoveDevice: ({ deviceId }) => account.remove(deviceId).pipe(Effect.mapError(refuse)),
        WatchAccountThreads: () => cloud.accountThreads,
        CloudThreadEvents: ({ machine, threadId }) =>
          cloud.cloudEvents(machine, threadId).pipe(Effect.mapError(refuse)),
        MarkThreadsRead: ({ entries }) => cloud.markRead(entries).pipe(Effect.mapError(refuse)),
        WatchAccountDrafts: () => cloud.accountDrafts,
        SaveDrafts: ({ drafts }) => cloud.saveDrafts(drafts).pipe(Effect.mapError(refuse)),
        WatchAccountTasks: () => cloud.accountTasks,
        SaveTasks: ({ tasks }) => cloud.saveTasks(tasks).pipe(Effect.mapError(refuse)),
        WatchWorking: () => workingNow,
        ReportPresence: (presence) => account.reportPresence(presence),
        SubscribePush: ({ subscription, kinds }) =>
          account.send({ _tag: "PushSubscribe", subscription, kinds }).pipe(Effect.mapError(refuse)),
        UnsubscribePush: () => account.send({ _tag: "PushUnsubscribe" }).pipe(Effect.mapError(refuse)),
        WatchNotifications: () => notifications,
        SaveEffortRouterKey: ({ key }) => saveKey(key),
      });
    }),
  );
