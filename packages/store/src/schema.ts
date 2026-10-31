import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["work", "chat"] }).notNull(),
  cwd: text("cwd"),
  /** The thread's own worktree (`ThreadWorktree`), when it runs in one. */
  worktree: text("worktree", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
  laterUntil: integer("later_until"),
  /** Shared by the threads one message started together (multi agent). */
  runId: text("run_id"),
  /** What the thread does when its harness's limit runs out (`LimitPolicy`); null follows the setting. */
  onLimit: text("on_limit", { enum: ["wait", "failover", "off"] }),
  /**
   * When the thread was last slimmed (`Store.slimThreads`): its events up to then hold no images and
   * no harness payloads. Null for a thread never slimmed.
   */
  slimmedAt: integer("slimmed_at"),
  /**
   * The first of the block of ports (`CERIUM_PORT`) the thread's scripts and terminals get, picked
   * when the thread first needed one and kept for the thread's life. Null until then.
   */
  port: integer("port"),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    /** Null for the thread's lead. */
    parentId: text("parent_id"),
    role: text("role").notNull(),
    provider: text("provider", {
      enum: ["claude", "codex", "muse", "cursor", "opencode", "grok", "antigravity"],
    }).notNull(),
    model: text("model").notNull(),
    effort: text("effort", { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] }),
    /** Null for agents never set to Auto. */
    autoEffort: integer("auto_effort", { mode: "boolean" }),
    /** Null for agents that run at their harness's default speed. */
    speed: text("speed", { enum: ["standard", "fast", "ultrafast"] }),
    access: text("access", { enum: ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"] }).notNull(),
    state: text("state", { enum: ["queued", "running", "idle", "stopped", "failed"] }).notNull(),
    providerSessionId: text("provider_session_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("agents_thread").on(table.threadId)],
);

/** Append-only canonical event log. Streaming deltas are not persisted. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    sequence: integer("sequence").notNull(),
    at: integer("at").notNull(),
    tag: text("tag").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    raw: text("raw", { mode: "json" }),
  },
  (table) => [
    uniqueIndex("events_agent_sequence").on(table.agentId, table.sequence),
    index("events_thread_at").on(table.threadId, table.at),
    // SQLite appends rowid to this index: cloud upload pages traverse a thread in stored order.
    index("events_thread").on(table.threadId),
    // Counting each thread's events the cloud copy keeps, every round of it, reads only this index;
    // without it, the count read every event's row (a tenth of a second on a 1.7 GB store).
    index("events_thread_tag").on(table.threadId, table.tag),
    // Reads of one kind of event (open questions and saved attachments at startup, usage for the
    // spend report) find them here instead of reading every event.
    index("events_tag_at").on(table.tag, table.at),
    // A tool's image, read on its own as the transcript scrolls to it, is found by its call here
    // instead of by searching the text of every tool result in its thread, screenshots and all.
    index("events_tool_call")
      .on(table.threadId, sql`json_extract(${table.payload}, '$.callId')`)
      .where(sql`${table.tag} = 'ToolCallCompleted'`),
  ],
);

/** The user's settings the backend applies, one JSON value per key. */
/** Compact UI history, separate from canonical rows holding images and provider diagnostics. */
export const uiEvents = sqliteTable(
  "ui_events",
  {
    id: text("id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    sequence: integer("sequence").notNull(),
    at: integer("at").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (table) => [index("ui_events_thread_at").on(table.threadId, table.at, table.sequence)],
);

/** Small metadata index: stable append positions survive deletes, and never read tool payloads. */
export const eventOrder = sqliteTable(
  "event_order",
  {
    position: integer("position").primaryKey({ autoIncrement: true }),
    id: text("id")
      .notNull()
      .unique()
      .references(() => events.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    at: integer("at").notNull(),
    sequence: integer("sequence").notNull(),
  },
  (table) => [
    index("event_order_history").on(table.threadId, table.at, table.sequence, table.id),
    index("event_order_resume").on(table.threadId, table.position),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

/** The folders the composer offers to work in: every one the user picked or ran a work thread in. */
export const projects = sqliteTable("projects", {
  path: text("path").primaryKey(),
  addedAt: integer("added_at").notNull(),
  /** When a thread last started in it, or the user last chose it. */
  usedAt: integer("used_at").notNull(),
  /**
   * The project's setup, run and teardown commands, as the user overrode them here (`""` turns one
   * off) and want shared by every thread's worktree of it. Null defers to the project's own
   * `.cerium.toml`.
   */
  setup: text("setup"),
  run: text("run"),
  teardown: text("teardown"),
  /**
   * The project's named commands as the user saved them here, which replace its `.cerium.toml`'s
   * `[actions]` whole. Null defers to the file.
   */
  actions: text("actions", { mode: "json" }).$type<ReadonlyArray<{ name: string; command: string }>>(),
});
