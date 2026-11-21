import { AcpTranslator, record, string, usageReport, type JsonRecord } from "@cerium/acp";

import { PROVIDER } from "./manifest.ts";

export const toolName = (call: JsonRecord) =>
  string(call["name"]) ??
  string(record(record(call["_meta"])?.["x.ai/tool"])?.["name"]) ??
  string(call["title"]) ??
  "Grok tool";

/** Grok reports the turn's usage, and the model and request it ran on, in the prompt result's `_meta`. */
export const usageFromPrompt = (result: unknown) => {
  const meta = record(record(result)?.["_meta"]);
  const model = string(meta?.["modelId"]);
  const requestId = string(meta?.["requestId"]);
  return usageReport({
    provider: PROVIDER,
    ...(model === undefined ? {} : { model }),
    ...(requestId === undefined ? {} : { requestId }),
    usage: record(meta?.["usage"]) ?? meta,
    inputIncludesCache: true,
  });
};

/** ACP's translation, with Grok's tool names and its usage; a command's nonzero exit fails its call. */
export const grokTranslator = () =>
  new AcpTranslator({
    provider: PROVIDER,
    toolName,
    toolInput: (call) => call["rawInput"],
    toolOutput: (call) => call["rawOutput"] ?? call["content"],
    toolFailed: (call) => {
      const exitCode = record(call["rawOutput"])?.["exit_code"];
      return typeof exitCode === "number" && exitCode !== 0;
    },
    usage: usageFromPrompt,
  });
