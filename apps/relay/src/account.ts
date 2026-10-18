import {
  credentialFromProtocols,
  hashSecret,
  randomToken,
  RELAY_PROTOCOL,
  type AccountId,
  type AccountProfile,
  type ConfirmLinkRequest,
  type Credential,
  type DeviceDraft,
  type DeviceId,
} from "@cerium/protocol";
import { DurableObject } from "cloudflare:workers";

import { approvedOnLink, mayManage, stateFor, type DeviceAction, type DeviceRow } from "./devices.ts";
import type { Env } from "./env.ts";
import { refusedSocket, signOut } from "./http.ts";

// One Cerium account (docs/architecture.md §14.4): its devices, and every device's WebSocket. The
// sockets hibernate between messages and `ping` is answered without waking the object, so an idle
// connection costs nothing.

/** What a refused action reports to the Worker, which answers with it. */
export type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

const done: Outcome = { ok: true };
const refused = (status: number, message: string): Outcome => ({ ok: false, status, message });

interface Attachment {
  readonly deviceId: string;
}

export class Account extends DurableObject<Env> {
  private readonly sql: SqlStorage;

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
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      approved_at INTEGER,
      last_seen_at INTEGER
    )`);
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
    this.sql.exec(
      `INSERT INTO devices (id, kind, name, platform, channel, version, secret_hash, created_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId,
      device.kind,
      device.name,
      device.platform,
      device.channel,
      device.version,
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
    server.serializeAttachment({ deviceId: row.id } satisfies Attachment);
    this.touch(row.id);
    this.broadcast();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL },
    });
  }

  override webSocketMessage(): void {
    // Devices only send `ping`, which the auto-response answers.
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
        this.sql.exec("UPDATE devices SET approved_at = ? WHERE id = ?", Date.now(), target.id);
      }
    });
  }

  async rename(credential: Credential, targetId: DeviceId, name: string): Promise<Outcome> {
    return this.manage(credential, targetId, "rename", (target) => {
      this.sql.exec("UPDATE devices SET name = ? WHERE id = ?", name, target.id);
    });
  }

  /** Removes a device: denying one that waits for approval, or signing one out. Its sockets close. */
  async remove(credential: Credential, targetId: DeviceId): Promise<Outcome> {
    return this.manage(credential, targetId, "remove", (target) => {
      this.sql.exec("DELETE FROM devices WHERE id = ?", target.id);
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

  private rows(): Array<DeviceRow> {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY created_at").toArray();
  }

  private row(id: string): DeviceRow | undefined {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", id).toArray()[0];
  }

  private touch(deviceId: string) {
    this.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", Date.now(), deviceId);
  }

  private closed(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment === null) return;
    this.touch(attachment.deviceId);
    this.broadcast(socket);
  }

  /** Sends every connected device the account's state; `closing` no longer counts as connected. */
  private broadcast(closing?: WebSocket) {
    const profile = this.profile();
    if (profile === undefined) return;
    const rows = this.rows();
    const attached = this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      return socket === closing || attachment === null ? [] : [{ socket, deviceId: attachment.deviceId }];
    });
    const online = new Set(attached.map(({ deviceId }) => deviceId));
    for (const { socket, deviceId } of attached) {
      const self = rows.find((row) => row.id === deviceId);
      if (self === undefined) {
        signOut(socket, "removed");
        continue;
      }
      try {
        socket.send(JSON.stringify(stateFor(self, rows, online, profile)));
      } catch {
        // The socket is closing; its close handler sends the others the change.
      }
    }
  }
}
