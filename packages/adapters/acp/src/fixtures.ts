import type { WireFrame } from "./connection.ts";
import type { PromptResponse, RequestPermissionRequest, SessionUpdate } from "./schema.ts";
import type { AcpRecord } from "./translate.ts";

// Turns the frames a session sent and received (`AcpSessionOverrides.record`) into the records its
// translator reads, so a recorded session replays in tests exactly as it ran: updates, permission
// requests and prompt answers in wire order.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class FixtureRecorder {
  readonly records: Array<AcpRecord> = [];
  /** Cerium's prompt requests by JSON-RPC id, whose answers end turns. */
  readonly #prompts = new Set<unknown>();
  #permissions = 0;

  constructor(opened?: { readonly sessionId: string; readonly model: string }) {
    if (opened !== undefined) this.records.push({ type: "opened", ...opened });
  }

  /** Marks where the session opened, once its id and model are known. */
  opened(sessionId: string, model: string) {
    this.records.unshift({ type: "opened", sessionId, model });
  }

  readonly frame = (frame: WireFrame) => {
    const message = frame.message;
    if (!isRecord(message)) return;
    const method = typeof message["method"] === "string" ? message["method"] : undefined;
    if (frame.direction === "out") {
      if (method === "session/prompt") {
        this.#prompts.add(message["id"]);
        this.records.push({ type: "prompt" });
      }
      return;
    }
    if (method === "session/update" && isRecord(message["params"]) && isRecord(message["params"]["update"])) {
      this.records.push({ type: "update", update: message["params"]["update"] as unknown as SessionUpdate });
    } else if (method === "session/request_permission" && isRecord(message["params"])) {
      this.records.push({
        type: "permission",
        requestId: `recorded:permission:${++this.#permissions}`,
        request: message["params"] as unknown as RequestPermissionRequest,
      });
    } else if (method === undefined && this.#prompts.has(message["id"])) {
      this.#prompts.delete(message["id"]);
      if (isRecord(message["result"])) {
        this.records.push({ type: "prompted", response: message["result"] as unknown as PromptResponse });
      } else if (isRecord(message["error"])) {
        this.records.push({
          type: "promptFailed",
          message: typeof message["error"]["message"] === "string" ? message["error"]["message"] : "error",
          ...(typeof message["error"]["code"] === "number" ? { code: message["error"]["code"] } : {}),
        });
      }
    }
  };

  /** One record per line, as test fixtures keep them. */
  jsonl(): string {
    return `${this.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  }
}
