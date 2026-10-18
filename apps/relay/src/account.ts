import {
  credentialFromProtocols,
  DeviceMessage,
  hashSecret,
  randomToken,
  RELAY_PROTOCOL,
  type AccountId,
  type AccountProfile,
  type ConfirmLinkRequest,
  type ConnectionId,
  type Credential,
  type DeviceDraft,
  type DeviceId,
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
import { Option, Schema } from "effect";

import { approvedOnLink, mayManage, stateFor, type DeviceAction, type DeviceRow } from "./devices.ts";
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
import { appendBatch } from "./sync.ts";
import { routeFrame, type Live } from "./tunnel.ts";
import { pushTopic, sendPush } from "./webPush.ts";

// One Cerium account (docs/architecture.md §14.4): its devices, and every device's WebSocket. The
// sockets hibernate between messages and `ping` is answered without waking the object, so an idle
// connection costs nothing. Frames one device tunnels to another pass through here unread (§14.8),
// every desktop's threads are kept here, so every device sees them all (§14.9), and browsers that
// asked for them are sent push notifications about those threads (§14.11).

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

const decodeDeviceMessage = Schema.decodeUnknownOption(Schema.fromJsonString(DeviceMessage));

const send = (socket: WebSocket, message: RelayMessage) => {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket is closing; its close handler tells the others.
  }
};

export class Account extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** The devices table while the object is awake; every write drops it. */
  private cached: Array<DeviceRow> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      channel TEXT NOT NULL,
      version TEXT NOT NULL,
      rpc_version INTEGER,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      approved_at INTEGER,
      last_seen_at INTEGER
    )`);
    // Tables made before devices reported the RPC version they speak.
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray();
    if (!columns.some((column) => column.name === "rpc_version")) {
      this.sql.exec("ALTER TABLE devices ADD COLUMN rpc_version INTEGER");
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account_id TEXT NOT NULL,
      name TEXT,
      email TEXT,
      image_url TEXT
    )`);
    // The cloud copy: each machine's threads, their events in stored batches, and what was seen.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS threads (
      machine TEXT NOT NULL,
      thread TEXT NOT NULL,
      overview TEXT NOT NULL,
      events INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (machine, thread)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS event_batches (
      machine TEXT NOT NULL,
      thread TEXT NOT NULL,
      start INTEGER NOT NULL,
      events TEXT NOT NULL,
      PRIMARY KEY (machine, thread, start)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS read_state (
      thread TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    )`);
    // Browsers' push subscriptions, one per browser, with the kinds of notification each wants.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS push (
      device TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      kinds TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Adds a device that just signed in; it's approved at once only if no device of the account is. */
  async link(
    accountId: AccountId,
    device: DeviceDraft,
    secretHash: string,
    profile: ConfirmLinkRequest["profile"],
  ): Promise<{ readonly deviceId: DeviceId; readonly approved: boolean }> {
    const now = Date.now();
    const approved = approvedOnLink(this.rows());
    const deviceId = randomToken(16) as DeviceId;
    this.write(
      `INSERT INTO devices (id, kind, name, platform, channel, version, rpc_version, secret_hash, created_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId,
      device.kind,
      device.name,
      device.platform,
      device.channel,
      device.version,
      device.rpcVersion ?? null,
      secretHash,
      now,
      approved ? now : null,
    );
    this.sql.exec(
      `INSERT INTO profile (id, account_id, name, email, image_url) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, email = excluded.email, image_url = excluded.image_url`,
      accountId,
      profile.name ?? null,
      profile.email ?? null,
      profile.imageUrl ?? null,
    );
    this.broadcast();
    return { deviceId, approved };
  }

  /** Who the account belongs to, as the sign-in page last reported it. */
  profile(): AccountProfile | undefined {
    const row = this.sql
      .exec<{ account_id: string; name: string | null; email: string | null; image_url: string | null }>(
        "SELECT account_id, name, email, image_url FROM profile WHERE id = 1",
      )
      .toArray()[0];
    if (row === undefined) return undefined;
    return {
      id: row.account_id as AccountId,
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.email === null ? {} : { email: row.email }),
      ...(row.image_url === null ? {} : { imageUrl: row.image_url }),
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
    this.broadcast();
    if (row.approved_at !== null) this.welcome(server, row);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL },
    });
  }

  /** A tunnelled frame, passed on unread to the connection it's for (§14.8); or sync, or push. */
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
        ? { _tag: "Receive", from, channel: frame.channel, data: frame.data }
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

  async approve(credential: Credential, targetId: DeviceId): Promise<Outcome> {
    const outcome = await this.manage(credential, targetId, "approve", (target) => {
      if (target.approved_at === null) {
        this.write("UPDATE devices SET approved_at = ? WHERE id = ?", Date.now(), target.id);
      }
    });
    // Approved, it sees the account's threads from now on.
    const target = this.row(targetId);
    if (outcome.ok && target !== undefined) {
      for (const socket of this.ctx.getWebSockets(target.id)) this.welcome(socket, target);
    }
    return outcome;
  }

  async rename(credential: Credential, targetId: DeviceId, name: string): Promise<Outcome> {
    return this.manage(credential, targetId, "rename", (target) => {
      this.write("UPDATE devices SET name = ? WHERE id = ?", name, target.id);
    });
  }

  /** Removes a device: denying one that waits for approval, or signing one out. Its sockets close. */
  async remove(credential: Credential, targetId: DeviceId): Promise<Outcome> {
    return this.manage(credential, targetId, "remove", (target) => {
      this.write("DELETE FROM devices WHERE id = ?", target.id);
      this.sql.exec("DELETE FROM push WHERE device = ?", target.id);
      for (const socket of this.ctx.getWebSockets(target.id)) signOut(socket, "removed");
      // A machine leaving takes its threads out of the cloud; they stay on the machine.
      const threads = this.sql
        .exec<{ thread: string }>("SELECT thread FROM threads WHERE machine = ?", target.id)
        .toArray();
      this.sql.exec("DELETE FROM event_batches WHERE machine = ?", target.id);
      this.sql.exec("DELETE FROM threads WHERE machine = ?", target.id);
      if (threads.length > 0) {
        this.toApproved({
          _tag: "ThreadsChanged",
          threads: [],
          removed: threads.map(({ thread }) => ({
            machine: target.id as DeviceId,
            threadId: thread as ThreadId,
          })),
        });
      }
    });
  }

  private async manage(
    credential: Credential,
    targetId: DeviceId,
    action: DeviceAction,
    apply: (target: DeviceRow) => void,
  ): Promise<Outcome> {
    const actor = this.row(credential.deviceId);
    if (actor === undefined || !(await this.verify(actor, credential))) {
      return refused(401, "This device isn't signed in to the account.");
    }
    const target = this.row(targetId);
    if (target === undefined) return refused(404, "That device isn't part of your account anymore.");
    if (!mayManage(actor, target, action)) {
      return refused(403, "Approve this device from one that's already connected first.");
    }
    apply(target);
    this.broadcast();
    return done;
  }

  /** A thread's events from the cloud copy, for an approved device of the account. */
  async threadEvents(
    credential: Credential,
    machine: DeviceId,
    threadId: ThreadId,
  ): Promise<Outcome | string> {
    const reader = this.row(credential.deviceId);
    if (reader === undefined || !(await this.verify(reader, credential))) {
      return refused(401, "This device isn't signed in to the account.");
    }
    if (reader.approved_at === null)
      return refused(403, "Approve this device from one that's already connected first.");
    const batches = this.sql
      .exec<{ events: string }>(
        "SELECT events FROM event_batches WHERE machine = ? AND thread = ? ORDER BY start",
        machine,
        threadId,
      )
      .toArray();
    // The batches are JSON arrays already; joining them avoids parsing every event here.
    return `[${batches
      .map(({ events }) => events.slice(1, -1))
      .filter((inner) => inner !== "")
      .join(",")}]`;
  }

  /** A desktop keeping its threads' copy current, or a device saying what was seen (§14.9). */
  private sync(socket: WebSocket, self: Attachment, message: SyncMessage) {
    const sender = this.row(self.deviceId);
    if (sender === undefined || sender.approved_at === null) return;
    const machine = sender.id as DeviceId;
    const now = Date.now();
    switch (message._tag) {
      case "SyncThreads": {
        if (sender.kind !== "desktop" || message.threads.length === 0) return;
        for (const overview of message.threads) {
          this.sql.exec(
            `INSERT INTO threads (machine, thread, overview, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (machine, thread) DO UPDATE SET overview = excluded.overview, updated_at = excluded.updated_at`,
            machine,
            overview.thread.id,
            JSON.stringify(overview),
            now,
          );
        }
        return this.toApproved(
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
          this.sql.exec("DELETE FROM event_batches WHERE machine = ? AND thread = ?", machine, threadId);
          this.sql.exec("DELETE FROM threads WHERE machine = ? AND thread = ?", machine, threadId);
        }
        return this.toApproved(
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
        const stored = this.sql
          .exec<{ events: number }>(
            "SELECT events FROM threads WHERE machine = ? AND thread = ?",
            machine,
            message.threadId,
          )
          .toArray()[0];
        // Events wait for their thread's overview, which the machine sends first.
        if (stored === undefined)
          return send(socket, { _tag: "SyncAccepted", threadId: message.threadId, count: 0 });
        const { keep, count } = appendBatch(stored.events, message.start, message.events);
        if (keep.length > 0) {
          this.sql.exec(
            "INSERT OR REPLACE INTO event_batches (machine, thread, start, events) VALUES (?, ?, ?, ?)",
            machine,
            message.threadId,
            stored.events,
            JSON.stringify(keep),
          );
          this.sql.exec(
            "UPDATE threads SET events = ? WHERE machine = ? AND thread = ?",
            count,
            machine,
            message.threadId,
          );
        }
        return send(socket, { _tag: "SyncAccepted", threadId: message.threadId, count });
      }
      case "MarkRead": {
        if (message.entries.length === 0) return;
        for (const { threadId, seenAt } of message.entries) {
          this.sql.exec(
            `INSERT INTO read_state (thread, seen_at) VALUES (?, ?)
             ON CONFLICT (thread) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)`,
            threadId,
            seenAt,
          );
        }
        // Every device hears it, the sender too: its other windows and its own list keep up.
        return this.toApproved({ _tag: "ReadChanged", entries: message.entries });
      }
    }
  }

  /** A window saying what it shows, a machine saying a thread needs the user, a browser's push settings. */
  private async push(socket: WebSocket, self: Attachment, message: PushMessage) {
    const sender = this.row(self.deviceId);
    if (sender === undefined || sender.approved_at === null) return;
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
        this.sql.exec(
          `INSERT INTO push (device, endpoint, p256dh, auth, kinds, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (device) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
             auth = excluded.auth, kinds = excluded.kinds, updated_at = excluded.updated_at`,
          sender.id,
          message.subscription.endpoint,
          message.subscription.keys.p256dh,
          message.subscription.keys.auth,
          kinds,
          Date.now(),
        );
        // A browser renews its subscription each time it opens; only a change of kinds is news.
        if (before?.kinds !== kinds) this.broadcast();
        return;
      }
      case "PushUnsubscribe": {
        if (this.sql.exec("DELETE FROM push WHERE device = ?", sender.id).rowsWritten > 0) this.broadcast();
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
    const key = threadKey(machine.id, message.threadId);
    const targets = recipients(message.kind, key, this.pushRows(), rows, showing);
    if (targets.length === 0) return;
    // The computer is named once the account has more than one.
    const desktops = rows.filter((row) => row.kind === "desktop" && row.approved_at !== null);
    const payload = JSON.stringify({
      kind: message.kind,
      machine: machine.id as DeviceId,
      threadId: message.threadId,
      title: message.title.trim() || "Untitled thread",
      body: notificationBody(message.kind, message.detail, desktops.length > 1 ? machine.name : undefined),
    } satisfies PushPayload);
    const options = {
      ttl: PUSH_TTL_S,
      urgency: message.kind === "needsYou" ? "high" : "normal",
      topic: await pushTopic(key),
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
    for (const row of gone) this.sql.exec("DELETE FROM push WHERE device = ?", row.device);
    if (gone.length > 0) this.broadcast();
  }

  private pushRows(): Array<PushRow> {
    return this.sql.exec<PushRow>("SELECT * FROM push").toArray();
  }

  /** What an approved device gets on connecting: the account's threads, and for a desktop, its cursors. */
  private welcome(socket: WebSocket, device: DeviceRow) {
    const threads = this.sql
      .exec<{ machine: string; thread: string; overview: string; events: number }>(
        "SELECT machine, thread, overview, events FROM threads",
      )
      .toArray();
    const read = this.sql
      .exec<{ thread: string; seen_at: number }>("SELECT thread, seen_at FROM read_state")
      .toArray();
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
      read: read.map((row): ReadEntry => ({ threadId: row.thread as ThreadId, seenAt: row.seen_at })),
    });
  }

  /** Sends every approved device's sockets a message, but for the connection it came from. */
  private toApproved(message: RelayMessage, except?: string) {
    const approved = new Set(this.rows().flatMap((row) => (row.approved_at === null ? [] : [row.id])));
    for (const { socket, attachment } of this.live()) {
      if (attachment.connection !== except && approved.has(attachment.deviceId)) send(socket, message);
    }
  }

  private async verify(row: DeviceRow, credential: Credential): Promise<boolean> {
    return (await hashSecret(credential.secret)) === row.secret_hash;
  }

  private write(query: string, ...bindings: Array<SqlStorageValue>) {
    this.sql.exec(query, ...bindings);
    this.cached = undefined;
  }

  private rows(): Array<DeviceRow> {
    this.cached ??= this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY created_at").toArray();
    return this.cached;
  }

  private row(id: string): DeviceRow | undefined {
    return this.rows().find((row) => row.id === id);
  }

  private touch(deviceId: string) {
    this.write("UPDATE devices SET last_seen_at = ? WHERE id = ?", Date.now(), deviceId);
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
