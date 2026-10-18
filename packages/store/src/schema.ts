import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  mode: text("mode", { enum: ["work", "chat"] }).notNull(),
  cwd: text("cwd"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  archivedAt: integer("archived_at"),
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
    provider: text("provider", { enum: ["claude", "codex", "muse", "cursor"] }).notNull(),
    model: text("model").notNull(),
    effort: text("effort", { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] }),
    access: text("access", { enum: ["readOnly", "ask", "acceptEdits", "fullAccess"] }).notNull(),
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
  ],
);

/** The user's settings the backend applies, one JSON value per key. */
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
});
