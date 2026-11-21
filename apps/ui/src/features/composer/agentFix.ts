import type { MessageBox } from "./messageBox.ts";

export const OUTPUT_TAIL_LINES = 100;
export const OUTPUT_TAIL_CHARS = 12_000;

export interface AgentFixFailure {
  readonly command?: string | undefined;
  readonly context?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly message?: string | undefined;
  readonly output?: string | undefined;
}

export type AskAgentFix = (prompt: string) => Promise<"sent" | "draft">;

/** Keeps the end of the text without cutting a UTF-16 surrogate pair in half. */
export const lastText = (text: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const start = text.length - maxChars;
  const first = text.charCodeAt(start);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? start + 1 : start);
};

const plainOutput = (text: string): string =>
  text
    .replace(
      // oxlint-disable-next-line no-control-regex -- ANSI sequences start with control characters
      /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g,
      "",
    )
    .replace(/\r\n?/g, "\n")
    // oxlint-disable-next-line no-control-regex -- keep tabs and line breaks, discard other controls
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

const fencedOutput = (raw: string): string => {
  const text = plainOutput(raw)
    .replace(/^(?:[^\S\n]*\n)+/, "")
    .trimEnd();
  if (text === "") return "";
  const marker = "[Earlier output omitted]\n";
  const output =
    text.length > OUTPUT_TAIL_CHARS ? marker + lastText(text, OUTPUT_TAIL_CHARS - marker.length) : text;
  // Choose a fence the output cannot close, including when it contains Markdown of its own.
  const fenceLength = (runs: RegExp) => {
    let length = 3;
    for (const run of output.matchAll(runs)) length = Math.max(length, run[0].length + 1);
    return length;
  };
  const backticks = fenceLength(/`{3,}/g);
  const tildes = fenceLength(/~{3,}/g);
  const fence = backticks <= tildes ? "`".repeat(backticks) : "~".repeat(tildes);
  return `${fence}\n${output}\n${fence}`;
};

export const terminalSnippet = (selection: string): string => fencedOutput(selection);

export const agentFixPrompt = ({ command, context, exitCode, message, output }: AgentFixFailure): string => {
  const field = (label: string, value?: string) => {
    const text = plainOutput(value ?? "")
      .trim()
      .replace(/\s+/g, " ");
    return text === "" ? "" : `${label}: ${lastText(text, 1_000)}`;
  };
  const details = [
    field("Command", command),
    field("Context", context),
    field("Exit code", exitCode?.toString()),
    field("Failure", message),
  ].filter(Boolean);
  const tail = fencedOutput(output ?? "");
  return [
    "Please investigate and fix this failure.",
    details.join("\n"),
    tail === "" ? "" : `Output tail:\n${tail}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const appendAgentText = (box: Pick<MessageBox, "append">, text: string): void => {
  box.append({ segments: [{ kind: "text", text }] });
};
