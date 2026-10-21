import {
  buildFromQuery,
  credentialFromProtocols,
  DeviceMessage,
  hashSecret,
  MAX_DRAFT_BYTES,
  randomToken,
  RELAY_PROTOCOL,
  type AccountId,
  type AccountProfile,
  type ConfirmLinkRequest,
  type ConnectionId,
  type Credential,
  type DeviceDraft,
  type DeviceId,
  type DraftEntry,
  type Installation,
  type NotificationKind,
  type PushMessage,
  type PushPayload,
  type ReadEntry,
  type RelayMessage,
  type SyncMessage,
  type ThreadId,
  type ThreadOverview,
  type AccountThread,
} from "@cerium/protocol";
import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, isNull, lt, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { Option, Schema } from "effect";

import migrations from "../migrations/migrations.js";
import { leftBehind, stateFor, type DeviceRow } from "./devices.ts";
import { vapidKeys, type Env } from "./env.ts";
import { refusedSocket, signOut } from "./http.ts";
import {
  isShowing,
  kindsOf,
  notificationBody,
  recipients,
  threadKey,
  type Presence,
  type PushRow,
} from "./notify.ts";
import * as tables from "./schema.ts";
import { appendBatch } from "./sync.ts";
import { routeFrame, type Live } from "./tunnel.ts";
import { pushTopic, sendPush } from "./webPush.ts";

// One Cerium account: its devices, and every device's WebSocket. The sockets hibernate between
// messages and `ping` is answered without waking the object, so an idle connection costs nothing.
// Frames one device tunnels to another pass through here unread, every desktop's threads are kept
// here, so every device sees them all, and browsers that asked for them are sent push notifications
// about those threads.

/** What a refused action reports to the Worker, which answers with it. */
export type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

const done: Outcome = { ok: true };
const refused = (status: number, message: string): Outcome => ({ ok: false, status, message });

/** What each device socket carries through hibernation: who it is, and what its window shows. */
type Attachment = Live & Presence;

/** How long a push service keeps a notification for a phone that's off or out of reach. */
const PUSH_TTL_S = 24 * 60 * 60;

/** How long a sent or discarded draft is remembered as gone, against devices that were offline. */
const GONE_DRAFTS_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

const decodeDeviceMessage = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceMessage));

const send = (socket: WebSocket, message: RelayMessage) => {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket is closing; its close handler tells the others.
  }
};

export class Account extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;
  /** The devices table while the object is awake; every write drops it. */
  private cached: Array<DeviceRow> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    const toldApart = this.upgradeLegacy();
    migrate(this.db, migrations);
    // Tables made before installs were told apart: each sign-in added the device again, so the
    // copies earlier sign-ins left behind go, once.
    if (toldApart) {
      const online = new Set(this.live().map(({ attachment }) => attachment.deviceId));
      for (const row of leftBehind(this.rows(), online)) this.drop(row);
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * Brings an account made before its tables had Drizzle's migrations, which changed them in place,
   * up to the first migration. Says whether its devices only now record their install.
   */
  private upgradeLegacy(): boolean {
    const exists = (table: string) =>
      this.db.get(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`) !== undefined;
    if (exists("__drizzle_migrations") || !exists("devices")) return false;
    const columns = new Set(
      this.db
        .all<{ name: string }>(sql`SELECT name FROM pragma_table_info('devices')`)
        .map(({ name }) => name),
    );
    // Tables made before devices reported the RPC version they speak.
    if (!columns.has("rpc_version")) this.db.run(sql`ALTER TABLE devices ADD COLUMN rpc_version INTEGER`);
    // Devices used to wait for one already in the account to let them in; signing in is enough now.
    this.db
      .update(tables.devices)
      .set({ approvedAt: sql`${tables.devices.createdAt}` })
      .where(isNull(tables.devices.approvedAt))
      .run();
    if (columns.has("installation")) return false;
    this.db.run(sql`ALTER TABLE devices ADD COLUMN installation TEXT`);
    return true;
  }

  /**
   * Adds a device that just signed in, able to see and drive the account at once. An install signing
   * in again takes back its own place: its name, its threads and its id stay, with the new secret.
   */
  async link(
    accountId: AccountId,
    device: DeviceDraft,
    secretHash: string,
    installation: Installation | undefined,
    profile: ConfirmLinkRequest["profile"],
  ): Promise<DeviceId> {
    const now = Date.now();
    const again =
      installation === undefined ? undefined : this.rows().find((row) => row.installation === installation);
    const deviceId = (again?.id ?? randomToken(16)) as DeviceId;
    const build = {
      kind: device.kind,
      platform: device.platform,
      channel: device.channel,
      version: device.version,
      rpcVersion: device.rpcVersion ?? null,
      secretHash,
    };
    if (again === undefined) {
      this.write(
        this.db.insert(tables.devices).values({
          ...build,
          id: deviceId,
          name: device.name,
          createdAt: now,
          approvedAt: now,
          installation: installation ?? null,
        }),
      );
    } else {
      this.write(this.db.update(tables.devices).set(build).where(eq(tables.devices.id, deviceId)));
      // A connection still on the old secret isn't valid anymore.
      for (const socket of this.ctx.getWebSockets(deviceId)) signOut(socket, "invalid");
    }
    const who = {
      name: profile.name ?? null,
      email: profile.email ?? null,
      imageUrl: profile.imageUrl ?? null,
    };
    this.db
      .insert(tables.profile)
      .values({ id: 1, accountId, ...who })
      .onConflictDoUpdate({ target: tables.profile.id, set: who })
      .run();
    this.broadcast();
    return deviceId;
  }

  /** Who the account belongs to, as the sign-in page last reported it. */
  profile(): AccountProfile | undefined {
    const row = this.db.select().from(tables.profile).where(eq(tables.profile.id, 1)).get();
    if (row === undefined) return undefined;
    return {
      id: row.accountId as AccountId,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.email === null ? {} : { email: row.email }),
      ...(row.imageUrl === null ? {} : { imageUrl: row.imageUrl }),
    };
  }

  /** A device's WebSocket, authenticated by the credential it offers as a subprotocol. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const credential = credentialFromProtocols(request.headers.get("Sec-WebSocket-Protocol"));
    const row = credential === undefined ? undefined : this.row(credential.deviceId);
    if (credential !== undefined && row === undefined) {
      return refusedSocket("removed");
    }
    if (credential === undefined || row === undefined || !(await this.verify(row, credential))) {
      return refusedSocket("invalid");
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [row.id]);
    server.serializeAttachment({
      deviceId: row.id,
      connection: randomToken(12),
      connectedAt: Date.now(),
    } satisfies Attachment);
    this.touch(row.id);
    // A desktop may have updated since it signed in; the browsers driving it follow its build.
    const build = buildFromQuery(new URL(request.url).searchParams);
    if (build !== undefined) {
      this.write(
        this.db
          .update(tables.devices)
          .set({ version: build.version, rpcVersion: build.rpcVersion ?? null })
          .where(eq(tables.devices.id, row.id)),
      );
    }
    this.broadcast();
    this.welcome(server, row);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL },
    });
  }

  /** A tunnelled frame, passed on unread to the connection it's for; or sync, or push. */
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message === "ping") return;
    const frame = Option.getOrUndefined(decodeDeviceMessage(message));
    const self = this.attachment(socket);
    if (frame === undefined || self === undefined) return;
    switch (frame._tag) {
      case "Send":
      case "Close":
        break;
      case "Presence":
      case "Notify":
      case "PushSubscribe":
      case "PushUnsubscribe":
        return this.push(socket, self, frame);
      default:
        return this.sync(socket, self, frame);
    }
    const rows = this.rows();
    const live = this.live();
    const route = routeFrame(
      rows.find((row) => row.id === self.deviceId),
      frame.to,
      rows,
      live.map(({ attachment }) => attachment),
    );
    if ("undeliverable" in route) {
      if (frame._tag === "Send")
        send(socket, { _tag: "Undeliverable", channel: frame.channel, reason: route.undeliverable });
      return;
    }
    const target = live.find(({ attachment }) => attachment.connection === route.to.connection)?.socket;
    if (target === undefined) return;
    const from = { device: self.deviceId as DeviceId, connection: self.connection as ConnectionId };
    send(
      target,
      frame._tag === "Send"
        ? {
            _tag: "Receive",
            from,
            channel: frame.channel,
            data: frame.data,
            ...(frame.more === undefined ? {} : { more: frame.more }),
          }
        : { _tag: "Closed", from, channel: frame.channel },
    );
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    this.closed(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override webSocketError(socket: WebSocket): void {
    this.closed(socket);
  }

  async rename(credential: Credential, targetId: DeviceId, name: string): Promise<Outcome> {
    return this.manage(credential, targetId, (target) => {
      this.write(this.db.update(tables.devices).set({ name }).where(eq(tables.devices.id, target.id)));
    });
  }

  /** Removes a device, signing it out. Its sockets close. */
  async remove(credential: Credential, targetId: DeviceId): Promise<Outcome> {
    return this.manage(credential, targetId, (target) => this.drop(target));
  }

  /** Takes a device out of the account, and a machine's threads out of the cloud; they stay on it. */
  private drop(target: DeviceRow) {
    this.write(this.db.delete(tables.devices).where(eq(tables.devices.id, target.id)));
    this.db.delete(tables.push).where(eq(tables.push.device, target.id)).run();
    for (const socket of this.ctx.getWebSockets(target.id)) signOut(socket, "removed");
    const machine = eq(tables.threads.machine, target.id);
    const gone = this.db.select({ thread: tables.threads.thread }).from(tables.threads).where(machine).all();
    this.db.delete(tables.eventBatches).where(eq(tables.eventBatches.machine, target.id)).run();
    this.db.delete(tables.threads).where(machine).run();
    if (gone.length > 0) {
      this.toDevices({
        _tag: "ThreadsChanged",
        threads: [],
        removed: gone.map(({ thread }) => ({
          machine: target.id as DeviceId,
          threadId: thread as ThreadId,
        })),
      });
    }
  }

  /** Any device of the account may rename or remove any other. */
  private async manage(
    credential: Credential,
    targetId: DeviceId,
    apply: (target: DeviceRow) => void,
  ): Promise<Outcome> {
    const actor = this.row(credential.deviceId);
    if (actor === undefined || !(await this.verify(actor, credential))) {
      return refused(401, "This device isn't signed in to the account.");
    }
    const target = this.row(targetId);
    if (target === undefined) return refused(404, "That device isn't part of your account anymore.");
    apply(target);
    this.broadcast();
    return done;
  }

  /** A thread's events from the cloud copy, for a device of the account. */
  async threadEvents(
    credential: Credential,
    machine: DeviceId,
    threadId: ThreadId,
  ): Promise<Outcome | string> {
    const reader = this.row(credential.deviceId);
    if (reader === undefined || !(await this.verify(reader, credential))) {
      return refused(401, "This device isn't signed in to the account.");
    }
    const batches = this.db
      .select({ events: tables.eventBatches.events })
      .from(tables.eventBatches)
      .where(this.batchesOf(machine, threadId))
      .orderBy(asc(tables.eventBatches.start))
      .all();
    // The batches are JSON arrays already; joining them avoids parsing every event here.
    return `[${batches
      .map(({ events }) => events.slice(1, -1))
      .filter((inner) => inner !== "")
      .join(",")}]`;
  }

  /** A desktop keeping its threads' copy current, or a device saying what was seen. */
  private sync(socket: WebSocket, self: Attachment, message: SyncMessage) {
    const sender = this.row(self.deviceId);
    if (sender === undefined) return;
    const machine = sender.id as DeviceId;
    const now = Date.now();
    switch (message._tag) {
      case "SyncThreads": {
        if (sender.kind !== "desktop" || message.threads.length === 0) return;
        for (const overview of message.threads) {
          const latest = { overview: JSON.stringify(overview), updatedAt: now };
          this.db
            .insert(tables.threads)
            .values({ machine, thread: overview.thread.id, ...latest })
            .onConflictDoUpdate({ target: [tables.threads.machine, tables.threads.thread], set: latest })
            .run();
        }
        return this.toDevices(
          {
            _tag: "ThreadsChanged",
            threads: message.threads.map((overview) => ({ machine, overview })),
            removed: [],
          },
          self.connection,
        );
      }
      case "SyncRemoved": {
        if (sender.kind !== "desktop" || message.threadIds.length === 0) return;
        for (const threadId of message.threadIds) {
          this.db.delete(tables.eventBatches).where(this.batchesOf(machine, threadId)).run();
          this.db.delete(tables.threads).where(this.threadOf(machine, threadId)).run();
        }
        return this.toDevices(
          {
            _tag: "ThreadsChanged",
            threads: [],
            removed: message.threadIds.map((threadId) => ({ machine, threadId })),
          },
          self.connection,
        );
      }
      case "SyncEvents": {
        if (sender.kind !== "desktop") return;
        const thread = this.threadOf(machine, message.threadId);
        const stored = this.db
          .select({ events: tables.threads.events })
          .from(tables.threads)
          .where(thread)
          .get();
        // Events wait for their thread's overview, which the machine sends first.
        if (stored === undefined)
          return send(socket, { _tag: "SyncAccepted", threadId: message.threadId, count: 0 });
        const { keep, count } = appendBatch(stored.events, message.start, message.events);
        if (keep.length > 0) {
          const events = JSON.stringify(keep);
          const { eventBatches } = tables;
          this.db
            .insert(eventBatches)
            .values({ machine, thread: message.threadId, start: stored.events, events })
            .onConflictDoUpdate({
              target: [eventBatches.machine, eventBatches.thread, eventBatches.start],
              set: { events },
            })
            .run();
          this.db.update(tables.threads).set({ events: count }).where(thread).run();
        }
        return send(socket, { _tag: "SyncAccepted", threadId: message.threadId, count });
      }
      case "MarkRead": {
        if (message.entries.length === 0) return;
        const { readState } = tables;
        for (const { threadId, seenAt } of message.entries) {
          this.db
            .insert(readState)
            .values({ thread: threadId, seenAt })
            .onConflictDoUpdate({
              target: readState.thread,
              set: { seenAt: sql`max(${readState.seenAt}, excluded.seen_at)` },
            })
            .run();
        }
        // Every device hears it, the sender too: its other windows and its own list keep up.
        return this.toDevices({ _tag: "ReadChanged", entries: message.entries });
      }
      case "SaveDrafts": {
        const { drafts } = tables;
        const accepted: Array<DraftEntry> = [];
        const lost: Array<DraftEntry> = [];
        for (const entry of message.drafts) {
          const draft = entry.draft === undefined ? null : JSON.stringify(entry.draft);
          if (draft !== null && draft.length > MAX_DRAFT_BYTES) continue;
          const saved = { draft, updatedAt: entry.updatedAt };
          const written = this.db
            .insert(drafts)
            .values({ key: entry.key, ...saved })
            .onConflictDoUpdate({
              target: drafts.key,
              set: saved,
              setWhere: sql`excluded.updated_at > ${drafts.updatedAt}`,
            })
            .run().rowsWritten;
          if (written > 0) {
            accepted.push(entry);
            continue;
          }
          const newer = this.draftRows(eq(drafts.key, entry.key))[0];
          if (newer !== undefined && newer.updatedAt > entry.updatedAt) lost.push(newer);
        }
        this.db
          .delete(drafts)
          .where(and(isNull(drafts.draft), lt(drafts.updatedAt, now - GONE_DRAFTS_KEPT_MS)))
          .run();
        // The sender has its own edits already; it hears only of the ones they lost to.
        if (lost.length > 0) send(socket, { _tag: "DraftsChanged", drafts: lost });
        if (accepted.length > 0) this.toDevices({ _tag: "DraftsChanged", drafts: accepted }, self.connection);
        return;
      }
    }
  }

  /** Drafts as devices see them, those `where` picks. */
  private draftRows(where?: SQL): Array<DraftEntry> {
    return this.db
      .select()
      .from(tables.drafts)
      .where(where)
      .all()
      .map((row) => ({
        key: row.key,
        updatedAt: row.updatedAt,
        ...(row.draft === null
          ? {}
          : { draft: JSON.parse(row.draft) as Exclude<DraftEntry["draft"], undefined> }),
      }));
  }

  /** A window saying what it shows, a machine saying a thread needs the user, a browser's push settings. */
  private async push(socket: WebSocket, self: Attachment, message: PushMessage) {
    const sender = this.row(self.deviceId);
    if (sender === undefined) return;
    switch (message._tag) {
      case "Presence": {
        socket.serializeAttachment({
          deviceId: self.deviceId,
          connection: self.connection,
          connectedAt: self.connectedAt,
          visible: message.visible,
          ...(message.viewing === undefined
            ? {}
            : { viewing: threadKey(message.viewing.machine, message.viewing.threadId) }),
          presenceAt: Date.now(),
        } satisfies Attachment);
        return;
      }
      case "PushSubscribe": {
        if (sender.kind !== "browser") return;
        const before = this.pushRows().find((row) => row.device === sender.id);
        const kinds = JSON.stringify(message.kinds);
        const subscription = {
          endpoint: message.subscription.endpoint,
          p256dh: message.subscription.keys.p256dh,
          auth: message.subscription.keys.auth,
          kinds,
          updatedAt: Date.now(),
        };
        this.db
          .insert(tables.push)
          .values({ device: sender.id, ...subscription })
          .onConflictDoUpdate({ target: tables.push.device, set: subscription })
          .run();
        // A browser renews its subscription each time it opens; only a change of kinds is news.
        if (before?.kinds !== kinds) this.broadcast();
        return;
      }
      case "PushUnsubscribe": {
        const removed = this.db.delete(tables.push).where(eq(tables.push.device, sender.id)).run();
        if (removed.rowsWritten > 0) this.broadcast();
        return;
      }
      case "Notify": {
        if (sender.kind !== "desktop") return;
        return this.notify(sender, message);
      }
    }
  }

  /** Sends a thread's notification to every browser that wants it and isn't looking already. */
  private async notify(machine: DeviceRow, message: Extract<PushMessage, { readonly _tag: "Notify" }>) {
    const vapid = vapidKeys(this.env);
    if (vapid === undefined) return;
    const now = Date.now();
    const rows = this.rows();
    const showing = this.live().flatMap(({ socket, attachment }) =>
      isShowing(attachment, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0, now)
        ? [attachment]
        : [],
    );
    const key = message.threadId === undefined ? undefined : threadKey(machine.id, message.threadId);
    const targets = recipients(message.kind, key, this.pushRows(), rows, showing);
    if (targets.length === 0) return;
    // The computer is named once the account has more than one.
    const desktops = rows.filter((row) => row.kind === "desktop");
    const payload = JSON.stringify({
      kind: message.kind,
      machine: machine.id as DeviceId,
      ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
      title: message.title.trim() || (message.kind === "limit" ? "Usage limit" : "Untitled thread"),
      body: notificationBody(message.kind, message.detail, desktops.length > 1 ? machine.name : undefined),
    } satisfies PushPayload);
    const options = {
      ttl: PUSH_TTL_S,
      urgency: message.kind === "needsYou" ? "high" : "normal",
      // A newer warning about a meter replaces one the push service still holds for it.
      topic: await pushTopic(key ?? `${machine.id}:limit:${message.title}`),
    } as const;
    const results = await Promise.all(
      targets.map((row) =>
        sendPush(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          vapid,
          options,
        ).catch((error: unknown) => {
          console.error("A push failed", error);
          return "failed" as const;
        }),
      ),
    );
    // A subscription its push service no longer knows is gone for good: the browser turned it off.
    const gone = targets.filter((_, index) => results[index] === "gone");
    for (const row of gone) this.db.delete(tables.push).where(eq(tables.push.device, row.device)).run();
    if (gone.length > 0) this.broadcast();
  }

  private pushRows(): Array<PushRow> {
    return this.db.select().from(tables.push).all();
  }

  /** What a device gets on connecting: the account's threads, and for a desktop, its cursors. */
  private welcome(socket: WebSocket, device: DeviceRow) {
    const { machine, thread, overview, events } = tables.threads;
    const threads = this.db.select({ machine, thread, overview, events }).from(tables.threads).all();
    const read = this.db.select().from(tables.readState).all();
    if (device.kind === "desktop") {
      send(socket, {
        _tag: "SyncCursors",
        threads: Object.fromEntries(
          threads.filter((row) => row.machine === device.id).map((row) => [row.thread, row.events]),
        ),
      });
    }
    send(socket, {
      _tag: "AccountThreads",
      threads: threads.map((row): AccountThread => ({
        machine: row.machine as DeviceId,
        overview: JSON.parse(row.overview) as ThreadOverview,
      })),
      read: read.map((row): ReadEntry => ({ threadId: row.thread as ThreadId, seenAt: row.seenAt })),
    });
    send(socket, { _tag: "AccountDrafts", drafts: this.draftRows() });
  }

  /** Sends every device's sockets a message, but for the connection it came from. */
  private toDevices(message: RelayMessage, except?: string) {
    for (const { socket, attachment } of this.live()) {
      if (attachment.connection !== except) send(socket, message);
    }
  }

  private async verify(row: DeviceRow, credential: Credential): Promise<boolean> {
    return (await hashSecret(credential.secret)) === row.secretHash;
  }

  /** Runs a write to the devices table. */
  private write(query: { run(): unknown }) {
    query.run();
    this.cached = undefined;
  }

  private rows(): Array<DeviceRow> {
    this.cached ??= this.db.select().from(tables.devices).orderBy(asc(tables.devices.createdAt)).all();
    return this.cached;
  }

  private row(id: string): DeviceRow | undefined {
    return this.rows().find((row) => row.id === id);
  }

  private touch(deviceId: string) {
    this.write(
      this.db.update(tables.devices).set({ lastSeenAt: Date.now() }).where(eq(tables.devices.id, deviceId)),
    );
  }

  private threadOf(machine: string, threadId: string) {
    return and(eq(tables.threads.machine, machine), eq(tables.threads.thread, threadId));
  }

  private batchesOf(machine: string, threadId: string) {
    return and(eq(tables.eventBatches.machine, machine), eq(tables.eventBatches.thread, threadId));
  }

  private attachment(socket: WebSocket): Attachment | undefined {
    return (socket.deserializeAttachment() as Attachment | null) ?? undefined;
  }

  /** Every device socket, with what it carries; `closing` no longer counts. */
  private live(closing?: WebSocket) {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = this.attachment(socket);
      return socket === closing || attachment === undefined ? [] : [{ socket, attachment }];
    });
  }

  private closed(socket: WebSocket) {
    const attachment = this.attachment(socket);
    if (attachment === undefined) return;
    this.touch(attachment.deviceId);
    this.broadcast(socket);
    // Channels with this connection end with it.
    for (const other of this.live(socket)) {
      send(other.socket, { _tag: "Gone", connection: attachment.connection as ConnectionId });
    }
  }

  /** Sends every connected device the account's state; `closing` no longer counts as connected. */
  private broadcast(closing?: WebSocket) {
    const profile = this.profile();
    if (profile === undefined) return;
    const rows = this.rows();
    const notifications = new Map<string, ReadonlyArray<NotificationKind>>(
      this.pushRows().map((row) => [row.device, kindsOf(row)]),
    );
    const attached = this.live(closing);
    const online = new Set(attached.map(({ attachment }) => attachment.deviceId));
    for (const { socket, attachment } of attached) {
      const self = rows.find((row) => row.id === attachment.deviceId);
      if (self === undefined) {
        signOut(socket, "removed");
        continue;
      }
      send(socket, stateFor(self, rows, online, profile, attachment.connection, notifications));
    }
  }
}
