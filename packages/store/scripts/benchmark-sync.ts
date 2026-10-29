// node packages/store/scripts/benchmark-sync.ts [events=100000] [page=500]
// Compare the former OFFSET ID query and the upload's rowid keyset query on the same database.
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const total = Number(process.argv[2] ?? 100_000);
const page = Number(process.argv[3] ?? 500);
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, at INTEGER NOT NULL, tag TEXT NOT NULL, payload TEXT NOT NULL, raw TEXT);
  CREATE UNIQUE INDEX events_agent_sequence ON events(agent_id, sequence);
  CREATE INDEX events_thread_at ON events(thread_id, at);
  CREATE INDEX events_thread_tag ON events(thread_id, tag);`);
const insert = db.prepare("INSERT INTO events VALUES (?, 'thread', 'agent', ?, ?, ?, '{}', NULL)");
db.exec("BEGIN");
for (let i = 0; i < total; i++)
  insert.run(`event_${i}`, i, i, i % 10 === 0 ? "MessageDelta" : "MessageCompleted");
db.exec("COMMIT");
const oldSql =
  "SELECT rowid, id FROM events WHERE thread_id = ? AND tag NOT IN ('MessageDelta','ReasoningDelta') ORDER BY rowid LIMIT ? OFFSET ?";
const elapsed = (run: () => number) => {
  const start = performance.now();
  const rows = run();
  return { rows, ms: performance.now() - start };
};
const offset = db.prepare(oldSql);
const before = db.prepare(`EXPLAIN QUERY PLAN ${oldSql}`).all("thread", page, 0);
const old = elapsed(() => {
  let count = 0;
  for (;;) {
    const rows = offset.all("thread", page, count);
    count += rows.length;
    if (rows.length < page) return count;
  }
});
db.exec("CREATE INDEX events_thread ON events(thread_id)");
const keysetSql =
  "SELECT rowid, id FROM events WHERE thread_id = ? AND tag NOT IN ('MessageDelta','ReasoningDelta') AND rowid > (SELECT rowid FROM events WHERE id = ?) ORDER BY rowid LIMIT ?";
const keyset = db.prepare(keysetSql);
const after = db.prepare(`EXPLAIN QUERY PLAN ${keysetSql}`).all("thread", "event_0", page);
const current = elapsed(() => {
  let anchor = "event_0",
    count = 0;
  for (;;) {
    const rows = keyset.all("thread", anchor, page);
    count += rows.length;
    if (rows.length < page) return count;
    anchor = rows.at(-1)!["id"] as string;
  }
});
const countSql = db.prepare(
  "SELECT thread_id, count(*) FROM events WHERE tag NOT IN ('MessageDelta','ReasoningDelta') GROUP BY thread_id",
);
const counts = elapsed(() => {
  for (let i = 0; i < 20; i++) countSql.all();
  return 20;
});
console.log(
  JSON.stringify({ total, page, old, current, countMeanMs: counts.ms / counts.rows, before, after }, null, 2),
);
db.close();
