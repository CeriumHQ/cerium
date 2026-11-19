import { applyOverviewUpdate, type ThreadNotification, type ThreadOverview } from "@cerium/protocol";
import { DeviceRpcs, type BrowserCall, type BrowserOutcome } from "@cerium/rpc";
import { Effect, Layer, Schedule, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import type { BackendConnection } from "./backend.ts";
import type { PreviewThread } from "./preview.ts";

/** The local backend's desktop subscriptions outlive any one window or backend connection. */
export const watchBackendActivity = (options: {
  readonly signal: AbortSignal;
  readonly connection: () => Promise<BackendConnection>;
  readonly signedIn: (signedIn: boolean) => void;
  readonly working: (working: boolean) => void;
  readonly notify: (notification: ThreadNotification) => void;
  readonly previews: (threads: ReadonlyArray<PreviewThread>) => void;
  readonly browser: (call: BrowserCall) => Promise<BrowserOutcome>;
}) =>
  Effect.runPromiseExit(
    Effect.tryPromise(options.connection).pipe(
      Effect.flatMap(({ url, token }) =>
        Effect.gen(function* () {
          const client = yield* RpcClient.make(DeviceRpcs);
          yield* Effect.all(
            [
              client.WatchAccount().pipe(
                Stream.map((account) => account._tag === "SignedIn"),
                Stream.changes,
                Stream.runForEach((signedIn) => Effect.sync(() => options.signedIn(signedIn))),
              ),
              client
                .WatchNotifications()
                .pipe(Stream.runForEach((notification) => Effect.sync(() => options.notify(notification)))),
              client.WatchLocalThreadOverviews().pipe(
                Stream.scan(() => [] as ReadonlyArray<ThreadOverview>, applyOverviewUpdate),
                Stream.runForEach((threads) =>
                  Effect.sync(() => {
                    let working = false;
                    const owners = threads.map(({ thread, agents, awaitingApproval }) => {
                      const busy = agents.some(({ state }) => state === "running" || state === "queued");
                      working ||= busy;
                      return {
                        id: thread.id,
                        active: awaitingApproval || busy,
                        retired: thread.archivedAt !== undefined,
                      };
                    });
                    options.working(working);
                    options.previews(owners);
                  }),
                ),
              ),
              client.HostBrowser().pipe(
                Stream.mapEffect(
                  (call) =>
                    call === undefined
                      ? Effect.void
                      : Effect.promise(() => options.browser(call)).pipe(
                          Effect.flatMap((outcome) =>
                            client.AnswerBrowser({ requestId: call.requestId, outcome }),
                          ),
                        ),
                  { concurrency: "unbounded", unordered: true },
                ),
                Stream.runDrain,
              ),
            ],
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(Socket.layerWebSocket(`${url}?token=${encodeURIComponent(token)}`)),
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
              Layer.provide(RpcSerialization.layerJson),
            ),
          ),
        ),
      ),
      Effect.retry(Schedule.spaced("1 second")),
    ),
    { signal: options.signal },
  ).then(() => undefined);
