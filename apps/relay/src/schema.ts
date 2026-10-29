import type { Channel, DeviceKind } from "@cerium/protocol";
import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The Account object's tables. drizzle-kit generates their migrations (`bun run --cwd apps/relay
// db:generate`), which the object applies when it starts.

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<DeviceKind>().notNull(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  channel: text("channel").$type<Channel>().notNull(),
  version: text("version").notNull(),
  rpcVersion: integer("rpc_version"),
  secretHash: text("secret_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  /** From when devices waited for one already in the account to let them in; nothing reads it. */
  approvedAt: integer("approved_at"),
  lastSeenAt: integer("last_seen_at"),
  /** The install it is (`Installation`); null for devices that joined before installs were told apart. */
  installation: text("installation"),
});

/** Who the account belongs to, as the sign-in page last reported it: one row. */
export const profile = sqliteTable(
  "profile",
  {
    id: integer("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name"),
    email: text("email"),
    imageUrl: text("image_url"),
  },
  (table) => [check("profile_single", sql`${table.id} = 1`)],
);

/** The cloud copy of each machine's threads; `events` counts the events stored for it. */
export const threads = sqliteTable(
  "threads",
  {
    machine: text("machine").notNull(),
    thread: text("thread").notNull(),
    /** JSON `ThreadOverview`. */
    overview: text("overview").notNull(),
    events: integer("events").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.machine, table.thread] })],
);

/** A thread's events in the batches they were stored in, each a JSON array starting at `start`. */
export const eventBatches = sqliteTable(
  "event_batches",
  {
    machine: text("machine").notNull(),
    thread: text("thread").notNull(),
    start: integer("start").notNull(),
    events: text("events").notNull(),
  },
  (table) => [primaryKey({ columns: [table.machine, table.thread, table.start] })],
);

/** When each thread was last seen on any device. */
export const readState = sqliteTable("read_state", {
  thread: text("thread").primaryKey(),
  seenAt: integer("seen_at").notNull(),
});

/**
 * Drafts being written, by thread or new thread; a gone one keeps its row (draft NULL) a while, so a
 * device that was offline doesn't bring it back.
 */
export const drafts = sqliteTable("drafts", {
  key: text("key").primaryKey(),
  /** JSON draft. */
  draft: text("draft"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * The user's own tasks (the rail's Tasks); a deleted one keeps its row (task NULL) a while, so a
 * device that was offline doesn't bring it back.
 */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  /** JSON task. */
  task: text("task"),
  updatedAt: integer("updated_at").notNull(),
});

/** Browsers' push subscriptions, one per browser, with the kinds of notification each wants. */
export const push = sqliteTable("push", {
  device: text("device").primaryKey(),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  /** JSON array of `NotificationKind`. */
  kinds: text("kinds").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Assistants the user allowed into the account from outside Cerium, one OAuth grant each (oauth.ts).
 * Only hashes of its code and tokens are kept. A grant waits with a code until the assistant redeems
 * it for tokens; one never redeemed is dropped once its code expires.
 */
export const assistants = sqliteTable("assistants", {
  id: text("id").primaryKey(),
  /** What the assistant calls itself. */
  name: text("name").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  codeHash: text("code_hash"),
  /** PKCE's S256 challenge the code was asked with. */
  codeChallenge: text("code_challenge"),
  codeExpiresAt: integer("code_expires_at"),
  accessHash: text("access_hash"),
  accessExpiresAt: integer("access_expires_at"),
  refreshHash: text("refresh_hash"),
});
