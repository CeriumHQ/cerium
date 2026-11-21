import type { McpServerSpec, SessionOptions, TurnImage } from "@cerium/harness";
import type { ModelSpeed, ReasoningEffort } from "@cerium/protocol";

import { array, record, string, type JsonRecord } from "./json.ts";

const pairs = (fields: Readonly<Record<string, string>> | undefined) =>
  Object.entries(fields ?? {}).map(([name, value]) => ({ name, value }));

export interface McpFormat {
  /**
   * ACP's stdio servers carry no `type`. Some agents want `type: "stdio"` anyway; this adds it.
   */
  readonly tagStdio?: boolean;
}

/** One server Cerium injects, as ACP's `mcpServers` lists it: headers and env become name/value pairs. */
export const toAcpMcpServer = (name: string, server: McpServerSpec, format: McpFormat = {}) =>
  server.type === "http"
    ? { name, type: "http" as const, url: server.url, headers: pairs(server.headers) }
    : {
        name,
        ...(format.tagStdio ? { type: "stdio" as const } : {}),
        command: server.command,
        args: server.args,
        env: pairs(server.env),
      };

export type AcpMcpServer = ReturnType<typeof toAcpMcpServer>;

/**
 * The session's injected servers for `session/new`. A read-only session gets only the trusted
 * ones, whose tools run without asking, since nothing else could be approved.
 */
export const acpMcpServers = (options: SessionOptions, format: McpFormat = {}) => {
  const trusted = new Set(options.trustedMcpServers);
  return Object.entries(options.mcpServers)
    .filter(([name]) => options.access !== "readOnly" || trusted.has(name))
    .map(([name, server]) => toAcpMcpServer(name, server, format));
};

export const hasHttpMcp = (servers: ReadonlyArray<AcpMcpServer>) =>
  servers.some((server) => server.type === "http");

/** A turn's text and images as ACP content blocks. */
export const promptBlocks = (text: string, images: ReadonlyArray<TurnImage> = []) => [
  { type: "text", text },
  ...images.map(({ mediaType, data }) => ({ type: "image", mimeType: mediaType, data })),
];

export type StopReason = "completed" | "interrupted" | "maxTurns" | "error";

/** `session/prompt`'s `stopReason` as Cerium's. Anything unknown, `refusal` included, is an error. */
export const toStopReason = (result: unknown): StopReason => {
  switch (record(result)?.["stopReason"]) {
    case "end_turn":
    case "stop_sequence":
      return "completed";
    case "cancelled":
      return "interrupted";
    case "max_turn_requests":
    case "max_tokens":
      return "maxTurns";
    default:
      return "error";
  }
};

// Permission requests.

export const cancelledOutcome = { outcome: { outcome: "cancelled" } } as const;
export const selectedOutcome = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

/**
 * The once-only options of a `session/request_permission`. Cerium's approvals cover one call at
 * most, so the `*_always` options, which agents keep beyond the conversation, are never chosen.
 */
export const onceOptions = (params: JsonRecord) => {
  const choices = array(params["options"]).map(record);
  const find = (kind: string) => string(choices.find((choice) => choice?.["kind"] === kind)?.["optionId"]);
  return { allow: find("allow_once"), deny: find("reject_once") };
};

export type OnceOptions = ReturnType<typeof onceOptions>;

/** The reply that refuses a permission request: its reject option, or a cancel when it has none. */
export const refusal = ({ deny }: OnceOptions) =>
  deny === undefined ? cancelledOutcome : selectedOutcome(deny);

// Session configuration (`configOptions`).

export interface ConfigChoice {
  readonly value: string;
  readonly name?: string;
  readonly description?: string;
  /** The agent's own `_meta` for the choice. */
  readonly meta?: JsonRecord;
}

export interface ConfigOption {
  readonly id: string;
  readonly currentValue: string;
  readonly options: ReadonlyArray<ConfigChoice>;
}

/** A session's select options (`mode`, `model`, `thought_level`…), skipping any it can't read. */
export const readConfigOptions = (value: unknown): ReadonlyArray<ConfigOption> =>
  array(value).flatMap((entry) => {
    const option = record(entry);
    const id = string(option?.["id"]);
    const currentValue = string(option?.["currentValue"]);
    if (id === undefined || currentValue === undefined) return [];
    const options = array(option?.["options"]).flatMap((item): ReadonlyArray<ConfigChoice> => {
      const choice = record(item);
      const value = string(choice?.["value"]);
      if (value === undefined) return [];
      const name = string(choice?.["name"]);
      const description = string(choice?.["description"]);
      const meta = record(choice?.["_meta"]);
      return [
        {
          value,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(meta === undefined ? {} : { meta }),
        },
      ];
    });
    return [{ id, currentValue, options }];
  });

export const configOption = (config: ReadonlyArray<ConfigOption>, id: string) =>
  config.find((option) => option.id === id);

// Model variants.

/** Cerium's efforts, lowest first. */
export const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const SPEEDS: ReadonlyArray<ModelSpeed> = ["standard", "fast", "ultrafast"];

/**
 * The effort to ask for, of those a model offers: `minimal`, Cerium's lowest, stands for the
 * model's own lowest. `undefined` when the model doesn't offer it.
 */
export const effortChoice = (offered: ReadonlyArray<ReasoningEffort>, wanted: ReasoningEffort) => {
  const choice = wanted === "minimal" && !offered.includes("minimal") ? offered[0] : wanted;
  return choice !== undefined && offered.includes(choice) ? choice : undefined;
};
