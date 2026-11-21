import type { AdapterEvent, PastHistory, PastSession, PastTurn } from "@cerium/harness";
import { Effect } from "effect";

import type { AcpConnection } from "./connection.ts";
import { needsLogin } from "./errors.ts";
import { loginRequired } from "./harness.ts";
import { record, string, type JsonRecord } from "./json.ts";
import { configOption, readConfigOptions } from "./protocol.ts";
import type { AcpTranslator } from "./translate.ts";

export const acpTimestamp = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};

const historyCall = (acp: AcpConnection, method: string, params: object) =>
  acp
    .query(method, params)
    .pipe(
      Effect.mapError((error) =>
        needsLogin(error)
          ? loginRequired(acp.harness)
          : error._tag === "HarnessFailure"
            ? error
            : acp.failure(
                `${acp.harness.label} could not ${method === "session/list" ? "list sessions" : "read this session"} (ACP ${error.code})`,
              ),
      ),
    );

/** Lists all saved sessions with ACP's unfiltered, paginated session list. */
export const listAcpSessions = Effect.fn("Acp.listSessions")(function* (
  acp: AcpConnection,
  details?: (
    row: JsonRecord,
  ) => Partial<Pick<PastSession, "createdAt" | "model" | "title" | "turns">> | false,
) {
  if (!acp.agent.listSessions) return yield* acp.failure("This CLI cannot list saved sessions over ACP");
  const sessions = new Map<string, PastSession>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = record(yield* historyCall(acp, "session/list", cursor === undefined ? {} : { cursor }));
    if (!Array.isArray(response?.["sessions"])) {
      return yield* acp.failure("The CLI returned an invalid ACP session list");
    }
    for (const value of response["sessions"]) {
      const item = record(value);
      const id = string(item?.["sessionId"]);
      const cwd = string(item?.["cwd"]);
      if (!id || !cwd || item === undefined || sessions.has(id)) continue;
      const extra = details?.(item);
      if (extra === false) continue;
      sessions.set(id, {
        id,
        cwd,
        title: string(item?.["title"])?.trim() || `${acp.harness.label} session ${id}`,
        updatedAt: acpTimestamp(item["updatedAt"]) ?? 0,
        ...extra,
      });
    }
    cursor = string(response["nextCursor"]);
    if (cursor !== undefined) {
      if (cursors.has(cursor)) return yield* acp.failure("The CLI repeated an ACP session list cursor");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
});

/** Collects the replay before `session/load` returns. No prompt or approval is sent. */
export const readAcpSession = Effect.fn("Acp.readSession")(function* (
  acp: AcpConnection,
  session: PastSession,
  translator: AcpTranslator,
  options: {
    readonly meta?: JsonRecord;
    readonly promptInfo?: (update: JsonRecord) => { readonly id?: string | number; readonly at?: number };
  } = {},
) {
  if (!acp.agent.loadSession) return yield* acp.failure("This CLI cannot replay saved sessions over ACP");
  if (!session.cwd) return yield* acp.failure("The saved session has no working directory");

  const turns: Array<PastTurn> = [];
  let current: { prompt: string; at?: number; events: Array<AdapterEvent> } | undefined;
  let readingPrompt = false;
  let promptId: string | number | undefined;
  let model: string | undefined;
  const finish = () => {
    if (current === undefined) return;
    current.events.push(...translator.finish(undefined, "").map((payload) => ({ payload })));
    turns.push(current);
    current = undefined;
  };

  acp.onMessage(({ method, id, params }) => {
    if (id !== undefined) return acp.reject(id);
    const envelope = record(params);
    const update = record(envelope?.["update"]);
    if (method !== "session/update" || envelope?.["sessionId"] !== session.id || update === undefined) {
      return Effect.void;
    }
    return Effect.sync(() => {
      if (update["sessionUpdate"] === "user_message_chunk") {
        const info = options.promptInfo?.(update);
        if (!readingPrompt || (info?.id !== undefined && info.id !== promptId)) finish();
        readingPrompt = true;
        promptId = info?.id;
        current ??= { prompt: "", events: [], ...(info?.at === undefined ? {} : { at: info.at }) };
        const content = record(update["content"]);
        if (content?.["type"] === "text") current.prompt += string(content["text"]) ?? "";
      } else if (update["sessionUpdate"] === "config_option_update") {
        model = configOption(readConfigOptions(update["configOptions"]), "model")?.currentValue ?? model;
      } else if (current !== undefined) {
        const payloads = translator.update(update);
        if (payloads.length === 0) return;
        readingPrompt = false;
        current.events.push(...payloads.map((payload) => ({ payload })));
      }
    });
  });
  const response = yield* historyCall(acp, "session/load", {
    sessionId: session.id,
    cwd: session.cwd,
    mcpServers: [],
    ...(options.meta === undefined ? {} : { _meta: options.meta }),
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => acp.onMessage(({ id }) => (id === undefined ? Effect.void : acp.reject(id)))),
    ),
  );
  finish();
  const result = record(response);
  model =
    configOption(readConfigOptions(result?.["configOptions"]), "model")?.currentValue ??
    string(record(result?.["models"])?.["currentModelId"]) ??
    model;
  return { turns, ...(model === undefined ? {} : { model }) } satisfies PastHistory;
});
