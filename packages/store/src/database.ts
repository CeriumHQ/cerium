import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import * as schema from "./schema.ts";

export type Database = SqliteRemoteDatabase<typeof schema>;

type Method = "run" | "all" | "values" | "get";

/**
 * Opens Cerium's SQLite database through Node's built-in `node:sqlite` (no native module to rebuild for
 * Electron) and exposes it to Drizzle through its proxy driver. Calls must be serialized by the caller:
 * Drizzle's proxy transactions share this single connection.
 */
export const openDatabase = (filename: string) => {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  // Full-text search over transcripts depends on FTS5; fail at startup rather than at first search.
  sqlite.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(x); DROP TABLE temp.fts5_probe;");

  const execute = (sql: string, params: ReadonlyArray<SQLInputValue>, method: Method) => {
    const statement = sqlite.prepare(sql);
    if (method === "run") {
      statement.run(...params);
      return { rows: [] };
    }
    statement.setReturnArrays(true);
    // `get` returns one row's values (or undefined); `all`/`values` return arrays of row values.
    return {
      rows: (method === "get" ? statement.get(...params) : statement.all(...params)) as Array<unknown>,
    };
  };

  const transaction = <A>(run: () => A): A => {
    sqlite.exec("BEGIN");
    try {
      const result = run();
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };

  const db: Database = drizzle(
    (sql, params, method) => Promise.resolve(execute(sql, params, method)),
    (queries) =>
      Promise.resolve(
        transaction(() => queries.map((query) => execute(query.sql, query.params, query.method))),
      ),
    { schema },
  );

  const runMigrations = (migrationsFolder: string) =>
    migrate(
      db,
      (queries) => Promise.resolve(transaction(() => queries.forEach((query) => sqlite.exec(query)))),
      { migrationsFolder },
    );

  return { db, runMigrations, close: () => sqlite.close() };
};
