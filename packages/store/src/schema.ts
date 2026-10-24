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
    provider: text("provider", { enum: ["claude", "codex", "muse", "cursor", "opencode"] }).notNull(),
    model: text("model").notNull(),
    effort: text("effort", { enum: ["minimal", "low", "medium", "high", "xhigh", "max"] }),
    /** Null for agents never set to Auto. */
    autoEffort: integer("auto_effort", { mode: "boolean" }),
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
    // Counting each thread's events the cloud copy keeps, every round of it, reads only this index;
    // without it, the count read every event's row (a tenth of a second on a 1.7 GB store).
    index("events_thread_tag").on(table.threadId, table.tag),
    // Reads of one kind of event (open questions and saved attachments at startup, usage for the
    // spend report) find them here instead of reading every event.
    index("events_tag_at").on(table.tag, table.at),
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
