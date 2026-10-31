import { HarnessFailure, type PastSession } from "@cerium/harness";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// UNDOCUMENTED FORMAT. Antigravity CLI lists its conversations in
// `~/.gemini/antigravity-cli/conversation_summaries.db`, a SQLite table whose schema was read from the
// 1.4.12 binary's own database (test/fixtures). Nothing documents it, so this is the only module that
// reads it, read-only, and a schema it doesn't recognise lists nothing rather than failing. Only the
// listing comes from it: each conversation's history sits in protobuf blobs Cerium doesn't decode, so an
// imported session resumes by `--conversation` without its past turns.

const require = createRequire(import.meta.url);

/** One row of `conversation_summaries`, the columns Cerium reads. */
export interface SummaryRow {
  readonly conversation_id: string;
  readonly title: string;
  readonly preview: string;
  readonly step_count: number;
  readonly last_modified_time: string;
  readonly workspace_uris: string;
  readonly agent_name: string;
  readonly parent_conversation_id: string;
  readonly nesting_depth: number;
}

export const summariesPath = (geminiHome: string) =>
  join(geminiHome, "antigravity-cli", "conversation_summaries.db");

const QUERY = `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris, agent_name,
  parent_conversation_id, nesting_depth FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 500`;

/** A workspace URI list as stored (`["file:///a"]`, or comma-separated) as its first folder. */
export const firstFolder = (uris: string): string | undefined => {
  let list: ReadonlyArray<unknown>;
  try {
    const parsed: unknown = JSON.parse(uris);
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    list = uris.split(",");
  }
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const uri = entry.trim();
    if (uri.startsWith("file:")) {
      try {
        return fileURLToPath(uri);
      } catch {
        continue;
      }
    }
    if (uri.startsWith("/") || /^[A-Za-z]:[\\/]/.test(uri)) return uri;
  }
  return undefined;
};

/** Go's SQLite time text (`2026-10-31 11:48:37.1+00:00`) as epoch milliseconds. */
const timeOf = (text: string) => {
  const parsed = Date.parse(text.replace(" ", "T").replace(/ ([+-]\d\d:?\d\d)$/, "$1"));
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Rows as past sessions: subagents' and Cerium's own (`cerium-…` agents) left out. */
export const toPastSessions = (rows: ReadonlyArray<SummaryRow>): ReadonlyArray<PastSession> =>
  rows.flatMap((row): ReadonlyArray<PastSession> => {
    if (row.conversation_id === "" || row.nesting_depth > 0 || row.parent_conversation_id !== "") return [];
    if (row.agent_name.startsWith("cerium-")) return [];
    const cwd = firstFolder(row.workspace_uris);
    const title =
      row.title.trim() || row.preview.trim().split(/\r?\n/)[0]?.slice(0, 120) || "Antigravity conversation";
    return [
      {
        id: row.conversation_id,
        ...(cwd === undefined ? {} : { cwd }),
        title,
        updatedAt: timeOf(row.last_modified_time),
        ...(row.step_count > 0 ? { turns: row.step_count } : {}),
      },
    ];
  });

/** The user's conversations, newest first; none when the database or its table isn't there. */
export const listAntigravitySessions = (geminiHome: string) =>
  Effect.try({
    try: () => {
      const path = summariesPath(geminiHome);
      if (!existsSync(path)) return [];
      const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const table = database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'")
          .get();
        if (table === undefined) return [];
        return toPastSessions(database.prepare(QUERY).all() as unknown as ReadonlyArray<SummaryRow>);
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      new HarnessFailure({
        provider: "antigravity",
        message: "Couldn't read Antigravity's conversation list",
        cause,
      }),
  });
