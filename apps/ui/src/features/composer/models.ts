import type { AccessMode, ProviderId, ReasoningEffort } from "@cerium/protocol";

export interface ModelOption {
  readonly id: string;
  readonly provider: ProviderId;
  readonly label: string;
  readonly efforts: ReadonlyArray<ReasoningEffort>;
}

// Development list; the real one comes from each adapter's model listing.
export const modelOptions: ReadonlyArray<ModelOption> = [
  {
    id: "claude-opus-5-5",
    provider: "claude",
    label: "Opus 5.5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-5-5",
    provider: "claude",
    label: "Sonnet 5.5",
    efforts: ["low", "medium", "high", "max"],
  },
  { id: "claude-haiku-5-5", provider: "claude", label: "Haiku 5.5", efforts: ["low", "medium", "high"] },
  {
    id: "gpt-6.1-sol",
    provider: "codex",
    label: "GPT-6.1 Sol",
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
  },
  { id: "gpt-6.1-terra", provider: "codex", label: "GPT-6.1 Terra", efforts: ["low", "medium", "high"] },
  {
    id: "muse-spark-1.3",
    provider: "muse",
    label: "Muse Spark 1.3",
    efforts: ["low", "medium", "high", "max"],
  },
  { id: "cursor-composer", provider: "cursor", label: "Cursor Composer", efforts: ["medium"] },
];

export const effortLabel: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const accessOptions: ReadonlyArray<{
  readonly value: AccessMode;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "readOnly", label: "Read only", description: "Reads and searches; never edits or runs commands" },
  { value: "ask", label: "Ask first", description: "Asks before every edit and command" },
  { value: "acceptEdits", label: "Accept edits", description: "Edits files freely; asks before commands" },
];
