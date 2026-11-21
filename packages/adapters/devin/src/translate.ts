import { AcpTranslator, record, string, usageReport, type JsonRecord } from "@cerium/acp";

import { PROVIDER } from "./manifest.ts";

/** Devin's own tool name (`exec`, `write`, `mcp__server__tool`), which ACP's `kind` only groups. */
export const toolName = (call: JsonRecord) => {
  const meta = record(call["_meta"]);
  return (
    string(meta?.["cognition.ai/toolName"]) ??
    string(meta?.["cognition.ai/inferenceToolName"]) ??
    string(call["kind"]) ??
    string(call["title"]) ??
    "Tool"
  );
};

/** ACP's translation, with Devin's tool names and its usage, whose input count includes cache reads. */
export class DevinTranslator extends AcpTranslator {
  constructor() {
    super({
      provider: PROVIDER,
      toolName,
      usage: (result, model) =>
        usageReport({
          provider: PROVIDER,
          model,
          usage: record(result)?.["usage"],
          inputIncludesCache: true,
        }),
    });
  }
}
