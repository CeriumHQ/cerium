import {
  AccountProfile,
  AccountState,
  ClaimLinkResponse,
  CLOSE_BAD_CREDENTIAL,
  CLOSE_REMOVED,
  CreateLinkResponse,
  DeviceId,
  formatCredential,
  hashSecret,
  parseCredential,
  randomToken,
  RelayMessage,
  relayProtocols,
  type ChannelId,
  type CreateLinkRequest,
  type Credential,
  type DeviceDraft,
  type DeviceMessage,
  type PushMessage,
  type SyncNotice,
  type ThreadId,
  type TunnelMessage,
} from "@cerium/protocol";
import {
  Context,
  Data,
  Effect,
  FiberHandle,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
  type Scope,
} from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { Socket } from "effect/socket";

import { Vault } from "./vault.ts";

// A device's Cerium account (docs/architecture.md §14): signing in through the user's browser, the
// live connection to the relay that keeps the device reachable, and acting on the account's devices.
// The relay is the source of truth; the state here is the last one it sent. A desktop's backend and
// the web client (§14.10) run the same code.

/** A request about the account that failed; `message` is written for the user. */
export class AccountError extends Schema.TaggedError<AccountError>()("AccountError", {
  message: Schema.String,
  /** The relay's HTTP status, when it answered. */
  status: Schema.optionalKey(Schema.Int),
}) {}

/** Cerium's own relay. */
export const DEFAULT_RELAY_URL = "https://cerium.nonlooped.xyz";

/**
 * What the relay says besides the account's state: tunnel messages (docs/architecture.md §14.8) and
 * sync notices (§14.9), and `RelayLost` when this device's connection to the relay drops, which ends
 * every channel it carried.
 */
export type RelayEvent = TunnelMessage | SyncNotice | { readonly _tag: "RelayLost" };

export interface AccountOptions {
  /** The relay, e.g. `https://cerium.nonlooped.xyz`. */
  readonly relayUrl: string;
  /** How this device describes itself when it signs in. */
  readonly device: DeviceDraft;
}

/** What the vault keeps once signed in: the credential and what the relay said about the account. */
const Linked = Schema.Struct({
  relayUrl: Schema.String,
  credential: Schema.String,
  account: AccountProfile,
  deviceId: DeviceId,
});
type Linked = typeof Linked.Type;

/**
 * What it keeps while the user confirms in the browser: the link and its secret, so a reload or a
 * restart picks the sign-in back up. The web client leaves the page to confirm (§14.10).
 */
const Pending = Schema.TaggedStruct("Pending", {
  relayUrl: Schema.String,
  link: CreateLinkResponse,
  secret: Schema.String,
});
type Pending = typeof Pending.Type;

const SavedJson = Schema.fromJsonString(Schema.Union([Linked, Pending]));

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RelayMessage));

/** How often a connected device pings the relay, and how long a silent connection is trusted. */
const PING_EVERY = "25 seconds";
const SILENT_FOR = "70 seconds";
/** How often a device waiting for the browser asks whether the user confirmed. */
const CLAIM_EVERY = "2 seconds";

/** Reconnecting backs off from one second to thirty, jittered so devices don't stampede. */
const reconnectDelay = (failures: number) => {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
};

/** What this device's window shows (docs/architecture.md §14.11). */
export type Presence = Omit<Extract<PushMessage, { readonly _tag: "Presence" }>, "_tag">;

/** The relay ended this device's sign-in: it was removed, or its credential isn't valid. */
class SignedOff extends Data.TaggedError("SignedOff")<{ readonly reason: "removed" | "invalid" }> {}

const signedOffMessage = {
  removed: "This device was removed from your Cerium account.",
  invalid: "This device's sign-in is no longer valid. Sign in again.",
} as const;

const unreachable = () =>
  new AccountError({ message: "Can't reach Cerium's cloud. Check your connection and try again." });

export class Account extends Context.Service<
  Account,
  {
    /** The account as this device knows it now, then every change. */
    readonly changes: Stream.Stream<AccountState>;
    /** Starts signing in; the user confirms at the returned page in their browser. */
    readonly signIn: Effect.Effect<{ readonly url: string }, AccountError>;
    readonly cancelSignIn: Effect.Effect<void>;
    /** Removes this device from the account and forgets its sign-in. */
    readonly signOut: Effect.Effect<void, AccountError>;
    approve(deviceId: DeviceId): Effect.Effect<void, AccountError>;
    rename(deviceId: DeviceId, name: string): Effect.Effect<void, AccountError>;
    /** Removes a device from the account; removing this one signs it out. */
    remove(deviceId: DeviceId): Effect.Effect<void, AccountError>;
    /** Sends a message through the relay; fails while this device isn't connected. */
    send(message: DeviceMessage): Effect.Effect<void, AccountError>;
    /**
     * Tells the relay what this device's window shows, now and again whenever it reconnects, so
     * nobody is notified about what they're looking at (§14.11).
     */
    reportPresence(presence: Presence): Effect.Effect<void>;
    /** What the relay says from now on, for as long as the scope lasts. */
    readonly relayEvents: Effect.Effect<PubSub.Subscription<RelayEvent>, never, Scope.Scope>;
    /** Another machine's thread from the cloud copy (§14.9), undecoded. */
    readThread(machine: DeviceId, threadId: ThreadId): Effect.Effect<unknown, AccountError>;
    /**
     * A channel this device opens to a machine, for as long as the scope lasts. A desktop both opens
     * channels and answers them, so answers on its own channels mustn't look like new ones.
     */
    readonly openChannel: Effect.Effect<ChannelId, never, Scope.Scope>;
    /** Whether this device opened the channel, rather than another device. */
    isOwnChannel(channel: ChannelId): boolean;
  }
>()("cerium/account/Account") {
  /** Requires `Vault`, an `HttpClient` and a `WebSocketConstructor`. */
  static readonly layer = (options: AccountOptions) =>
    Layer.effect(
      Account,
      Effect.gen(function* () {
        const vault = yield* Vault;
        const client = yield* HttpClient.HttpClient;
        const webSockets = yield* Socket.WebSocketConstructor;
        const state = yield* SubscriptionRef.make<AccountState>({ _tag: "SignedOut" });
        // The one long-running task: waiting for the browser, then staying connected.
        const session = yield* FiberHandle.make<void, never>();
        /** Writes to the relay while connected. */
        const live = yield* Ref.make<Option.Option<Socket.Writer>>(Option.none());
        const tunnelEvents = yield* PubSub.unbounded<RelayEvent>();
        const ownChannels = new Set<string>();
        /** What the window shows, as last reported; sent again on every connection. */
        let presence: Presence | undefined;
        const relay = options.relayUrl.replace(/\/+$/, "");

        // ---- The relay's HTTP API ------------------------------------------------------------

        /** The relay's answer, or its refusal's own message. */
        const refusal = (response: HttpClientResponse.HttpClientResponse) =>
          response.json.pipe(
            Effect.orElseSucceed(() => ({})),
            Effect.flatMap((body) => {
              const message = (body as { message?: unknown }).message;
              return Effect.fail(
                new AccountError({
                  message:
                    typeof message === "string"
                      ? message
                      : `Cerium's cloud refused the request (${response.status}).`,
                  status: response.status,
                }),
              );
            }),
          );

        const send = (request: HttpClientRequest.HttpClientRequest) =>
          client.execute(request).pipe(
            Effect.mapError(unreachable),
            Effect.filterOrElse((response) => response.status >= 200 && response.status < 300, refusal),
          );

        const decode =
          <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
          (response: HttpClientResponse.HttpClientResponse) =>
            response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              Effect.mapError(
                () =>
                  new AccountError({ message: "Cerium's cloud sent an answer Cerium doesn't understand." }),
              ),
            );

        const withCredential = (request: HttpClientRequest.HttpClientRequest, credential: Credential) =>
          request.pipe(HttpClientRequest.bearerToken(formatCredential(credential)));

        const createLink = (body: CreateLinkRequest) =>
          HttpClientRequest.post(`${relay}/api/links`).pipe(
            HttpClientRequest.bodyJson(body),
            Effect.orDie,
            Effect.flatMap(send),
            Effect.flatMap(decode(CreateLinkResponse)),
          );

        const claimLink = (id: string, secret: string) =>
          send(
            HttpClientRequest.post(`${relay}/api/links/${id}/claim`).pipe(
              HttpClientRequest.bearerToken(secret),
            ),
          ).pipe(Effect.flatMap(decode(ClaimLinkResponse)));

        // ---- State ---------------------------------------------------------------------------

        const update = (change: (current: AccountState) => AccountState) =>
          SubscriptionRef.update(state, change);

        const setConnection = (connection: "connecting" | "online" | "offline") =>
          update((current) => (current._tag === "SignedIn" ? { ...current, connection } : current));

        const save = (saved: Linked | Pending) =>
          Schema.encodeEffect(SavedJson)(saved).pipe(
            Effect.orDie,
            Effect.flatMap((text) => vault.write(text)),
          );

        /** Forgets the sign-in here, telling the user why when the relay ended it. */
        const forget = (error?: string) =>
          vault
            .write(undefined)
            .pipe(
              Effect.ignore,
              Effect.andThen(
                SubscriptionRef.set(
                  state,
                  error === undefined ? { _tag: "SignedOut" } : { _tag: "SignedOut", error },
                ),
              ),
            );

        // ---- The live connection -------------------------------------------------------------

        /** One connection to the relay, until it drops or the relay signs this device off. */
        const connectOnce = (credential: Credential, linked: Linked) =>
          Effect.gen(function* () {
            const socket = yield* Socket.makeWebSocket(`${relay.replace(/^http/, "ws")}/api/connect`, {
              protocols: relayProtocols(credential),
              openTimeout: "15 seconds",
            });
            const pull = yield* Socket.readerString(socket);
            const writer = yield* socket.writer;
            yield* Ref.set(live, Option.some(writer));
            yield* Effect.addFinalizer(() =>
              Ref.set(live, Option.none()).pipe(
                Effect.andThen(PubSub.publish(tunnelEvents, { _tag: "RelayLost" })),
              ),
            );
            yield* writer.write("ping").pipe(Effect.delay(PING_EVERY), Effect.forever, Effect.forkScoped);
            if (presence !== undefined) {
              yield* writer.write(JSON.stringify({ _tag: "Presence", ...presence } satisfies DeviceMessage));
            }
            while (true) {
              const frames = yield* pull.pipe(
                Effect.timeoutOrElse({
                  duration: SILENT_FOR,
                  orElse: () =>
                    Effect.fail(
                      new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: "silent" }) }),
                    ),
                }),
              );
              for (const frame of frames) {
                if (frame === "pong") continue;
                const message = Option.getOrUndefined(decodeMessage(frame));
                if (message === undefined) continue;
                if (message._tag === "SignedOut") return yield* new SignedOff({ reason: message.reason });
                if (message._tag !== "State") {
                  yield* PubSub.publish(tunnelEvents, message);
                  continue;
                }
                yield* SubscriptionRef.set(state, {
                  _tag: "SignedIn",
                  account: message.account,
                  deviceId: linked.deviceId,
                  connection: "online",
                  devices: message.devices,
                });
              }
            }
          }).pipe(
            Effect.scoped,
            Effect.provideService(Socket.WebSocketConstructor, webSockets),
            Effect.catchTag("SocketError", (error) => {
              const reason = error.reason;
              if (reason._tag === "SocketCloseError" && reason.code === CLOSE_REMOVED) {
                return Effect.fail(new SignedOff({ reason: "removed" }));
              }
              if (reason._tag === "SocketCloseError" && reason.code === CLOSE_BAD_CREDENTIAL) {
                return Effect.fail(new SignedOff({ reason: "invalid" }));
              }
              return Effect.void;
            }),
          );

        /** Stays connected, backing off between attempts, until the relay signs this device off. */
        const stayConnected = (linked: Linked) =>
          Effect.gen(function* () {
            const credential = parseCredential(linked.credential);
            if (credential === undefined) return yield* forget(signedOffMessage.invalid);
            let failures = 0;
            while (true) {
              const online = yield* SubscriptionRef.get(state).pipe(
                Effect.map((current) => current._tag === "SignedIn" && current.connection === "online"),
              );
              if (!online) yield* setConnection("connecting");
              const ended = yield* connectOnce(credential, linked).pipe(
                Effect.as(undefined),
                Effect.catchTag("SignedOff", Effect.succeed),
              );
              if (ended !== undefined) return yield* forget(signedOffMessage[ended.reason]);
              const wasOnline = yield* SubscriptionRef.get(state).pipe(
                Effect.map((current) => current._tag === "SignedIn" && current.connection === "online"),
              );
              failures = wasOnline ? 1 : failures + 1;
              yield* setConnection("offline");
              yield* Effect.sleep(reconnectDelay(failures));
            }
          });

        const start = (linked: Linked) =>
          SubscriptionRef.set(state, {
            _tag: "SignedIn",
            account: linked.account,
            deviceId: linked.deviceId,
            connection: "connecting",
            devices: [],
          }).pipe(Effect.andThen(FiberHandle.run(session, stayConnected(linked))), Effect.asVoid);

        // ---- Signing in ----------------------------------------------------------------------

        /** Asks the relay until the user confirms, then saves the sign-in and connects. */
        const waitForBrowser = ({ link, secret }: Pending) =>
          Effect.gen(function* () {
            while (Date.now() < link.expiresAt) {
              const claim = yield* claimLink(link.id, secret).pipe(
                Effect.map((answer) => ({ answer })),
                Effect.catch((error: AccountError) => Effect.succeed({ error })),
              );
              if ("answer" in claim && claim.answer._tag === "Linked") {
                const credential = {
                  accountId: claim.answer.account.id,
                  deviceId: claim.answer.deviceId,
                  secret,
                };
                const linked: Linked = {
                  relayUrl: relay,
                  credential: formatCredential(credential),
                  account: claim.answer.account,
                  deviceId: claim.answer.deviceId,
                };
                const saved = yield* save(linked).pipe(Effect.result);
                if (saved._tag === "Failure") {
                  return yield* SubscriptionRef.set(state, {
                    _tag: "SignedOut",
                    error: saved.failure.message,
                  });
                }
                yield* SubscriptionRef.set(state, {
                  _tag: "SignedIn",
                  account: linked.account,
                  deviceId: linked.deviceId,
                  connection: "connecting",
                  devices: [],
                });
                return yield* stayConnected(linked);
              }
              // Gone or refused: this link won't be confirmed. Anything else is worth asking again.
              if ("error" in claim && (claim.error.status === 410 || claim.error.status === 403)) break;
              yield* Effect.sleep(CLAIM_EVERY);
            }
            yield* forget("The sign-in wasn't confirmed in time. Try again.");
          });

        /** Waits for the browser on a link, kept so a reload or restart waits on it again. */
        const awaitLink = (pending: Pending) =>
          SubscriptionRef.set(state, {
            _tag: "SigningIn",
            url: pending.link.url,
            expiresAt: pending.link.expiresAt,
          }).pipe(Effect.andThen(FiberHandle.run(session, waitForBrowser(pending))), Effect.asVoid);

        const signIn = Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current._tag === "SignedIn") {
            return yield* new AccountError({ message: "This device is already signed in." });
          }
          // Opening the page again reuses the link it's waiting on.
          if (current._tag === "SigningIn" && current.expiresAt > Date.now() + 30_000)
            return { url: current.url };
          const secret = randomToken(32);
          const secretHash = yield* Effect.promise(() => hashSecret(secret));
          const link = yield* createLink({ device: options.device, secretHash });
          const pending: Pending = { _tag: "Pending", relayUrl: relay, link, secret };
          // Best effort: without it, the sign-in still finishes unless this device restarts first.
          yield* save(pending).pipe(Effect.ignore);
          yield* awaitLink(pending);
          return { url: link.url };
        });

        const cancelSignIn = Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(state))._tag !== "SigningIn") return;
          yield* FiberHandle.clear(session);
          yield* forget();
        });

        // ---- Acting on devices ---------------------------------------------------------------

        const readSaved = (text: string | undefined) =>
          text === undefined ? undefined : Option.getOrUndefined(Schema.decodeOption(SavedJson)(text));

        const signedIn = vault.read.pipe(
          Effect.mapError((error) => new AccountError({ message: error.message })),
          Effect.map(readSaved),
          Effect.flatMap((saved) => {
            const credential =
              saved === undefined || "_tag" in saved ? undefined : parseCredential(saved.credential);
            return credential === undefined
              ? Effect.fail(new AccountError({ message: "This device isn't signed in." }))
              : Effect.succeed(credential);
          }),
        );

        const deviceRequest = (
          make: (url: string) => HttpClientRequest.HttpClientRequest,
          deviceId: DeviceId,
          body?: unknown,
        ) =>
          Effect.gen(function* () {
            const credential = yield* signedIn;
            let request = withCredential(make(`${relay}/api/devices/${deviceId}`), credential);
            if (body !== undefined)
              request = yield* HttpClientRequest.bodyJson(request, body).pipe(Effect.orDie);
            yield* send(request);
          });

        const signOut = Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (current._tag === "SigningIn") return yield* cancelSignIn;
          if (current._tag !== "SignedIn") return;
          // Stop reconnecting first, so the relay closing the socket isn't taken as a dropped line.
          yield* FiberHandle.clear(session);
          // Best effort: a device the relay never hears from stays listed until another removes it.
          yield* deviceRequest(HttpClientRequest.delete, current.deviceId).pipe(
            Effect.timeout("10 seconds"),
            Effect.ignore,
          );
          yield* forget();
        });

        // ---- Startup -------------------------------------------------------------------------

        const saved = yield* vault.read.pipe(Effect.result);
        if (saved._tag === "Failure") {
          yield* SubscriptionRef.set(state, {
            _tag: "SignedOut",
            error: "Cerium couldn't read this device's sign-in. Sign in again.",
          });
        } else if (saved.success !== undefined) {
          const found = readSaved(saved.success);
          // A sign-in for another relay (a development one, say) can't be used here.
          if (found === undefined || found.relayUrl !== relay) yield* forget();
          else if (!("_tag" in found)) yield* start(found);
          else if (found.link.expiresAt > Date.now()) yield* awaitLink(found);
          else yield* forget();
        }

        const sendFrame = (message: DeviceMessage) =>
          Ref.get(live).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(unreachable()),
                onSome: (writer) => writer.write(JSON.stringify(message)).pipe(Effect.mapError(unreachable)),
              }),
            ),
          );

        return Account.of({
          send: sendFrame,
          reportPresence: (next) =>
            Effect.suspend(() => {
              presence = next;
              // Offline, it goes when the connection comes back.
              return sendFrame({ _tag: "Presence", ...next }).pipe(Effect.ignore);
            }),
          relayEvents: PubSub.subscribe(tunnelEvents),
          readThread: (machine, threadId) =>
            Effect.gen(function* () {
              const credential = yield* signedIn;
              const response = yield* send(
                withCredential(HttpClientRequest.get(`${relay}/api/sync/${machine}/${threadId}`), credential),
              );
              return yield* response.json.pipe(
                Effect.mapError(
                  () => new AccountError({ message: "Cerium's cloud sent a thread Cerium can't read." }),
                ),
              );
            }),
          openChannel: Effect.acquireRelease(
            Effect.sync(() => {
              const channel = randomToken(12) as ChannelId;
              ownChannels.add(channel);
              return channel;
            }),
            (channel) => Effect.sync(() => ownChannels.delete(channel)),
          ),
          isOwnChannel: (channel) => ownChannels.has(channel),
          changes: SubscriptionRef.changes(state),
          signIn,
          cancelSignIn,
          signOut,
          approve: (deviceId) => deviceRequest((url) => HttpClientRequest.post(`${url}/approve`), deviceId),
          rename: (deviceId, name) => deviceRequest(HttpClientRequest.patch, deviceId, { name }),
          remove: (deviceId) =>
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              if (current._tag === "SignedIn" && current.deviceId === deviceId) return yield* signOut;
              yield* deviceRequest(HttpClientRequest.delete, deviceId);
            }),
        });
      }),
    );
}
