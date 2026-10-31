import type { ModelInfo, ReasoningEffort } from "@cerium/protocol";

// UNDOCUMENTED FORMAT. `agy models` (1.4.12) prints its models as text and takes no
// `--output-format` (seen live; the flag is rejected). Prior-art wrappers read one model per line,
// `<id>\t<label>` or `<id>   <label>`; this parser takes either, skips the CLI's status lines, and is
// covered by test/models.test.ts. A model id that names its tier (`gemini-3.6-flash-high`) takes no
// `--effort`; any other is offered low, medium and high, which `--effort` accepts on every model.

const TIERED = /-(low|medium|high|xhigh|max)$/i;
const MODEL_ID = /^[a-z0-9][\w.:/-]*$/i;
const EFFORTS: ReadonlyArray<ReasoningEffort> = ["low", "medium", "high"];

/** `agy models` output as Cerium's models. */
export const parseModels = (output: string): ReadonlyArray<ModelInfo> => {
  const models: Array<ModelInfo> = [];
  for (const raw of output.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || /^(fetching|error|available|usage|models?:)/i.test(line)) continue;
    const marked = /^[*>]\s*/.test(line) || /\((default|current)\)/i.test(line);
    line = line
      .replace(/^[*>]\s*/, "")
      .replace(/\s*\((default|current)\)\s*/i, " ")
      .trim();
    const [id = "", ...rest] = line.split(/\t|\s{2,}/);
    if (!MODEL_ID.test(id) || models.some((model) => model.id === id)) continue;
    const label = rest.join(" ").trim();
    models.push({
      provider: "antigravity",
      id,
      label: label === "" ? id : label,
      efforts: TIERED.test(id) ? [] : EFFORTS,
      ...(marked ? { isDefault: true } : {}),
    });
  }
  return models;
};
