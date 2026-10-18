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
  type RelayMessage,
} from "@cerium/protocol";
import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";

import { approvedOnLink, mayManage, stateFor, type DeviceAction, type DeviceRow } from "./devices.ts";
import type { Env } from "./env.ts";
import { refusedSocket, signOut } from "./http.ts";
import { routeFrame, type Live } from "./tunnel.ts";

// One Cerium account (docs/architecture.md §14.4): its devices, and every device's WebSocket. The
// sockets hibernate between messages and `ping` is answered without waking the object, so an idle
// connection costs nothing. Frames one device tunnels to another pass through here unread (§14.8).

/** What a refused action reports to the Worker, which answers with it. */
export type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

const done: Outcome = { ok: true };
const refused = (status: number, message: string): Outcome => ({ ok: false, status, message });

/** What each device socket carries through hibernation. */
type Attachment = Live;

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
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL },
    });
  }

  /** A tunnelled frame, passed on unread to the connection it's for (§14.8). */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message === "ping") return;
    const frame = Option.getOrUndefined(decodeDeviceMessage(message));
    const self = this.attachment(socket);
    if (frame === undefined || self === undefined) return;
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
    return this.manage(credential, targetId, "approve", (target) => {
      if (target.approved_at === null) {
        this.write("UPDATE devices SET approved_at = ? WHERE id = ?", Date.now(), target.id);
      }
    });
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
      for (const socket of this.ctx.getWebSockets(target.id)) signOut(socket, "removed");
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
    const attached = this.live(closing);
    const online = new Set(attached.map(({ attachment }) => attachment.deviceId));
    for (const { socket, attachment } of attached) {
      const self = rows.find((row) => row.id === attachment.deviceId);
      if (self === undefined) {
        signOut(socket, "removed");
        continue;
      }
      send(socket, stateFor(self, rows, online, profile, attachment.connection));
    }
  }
}
