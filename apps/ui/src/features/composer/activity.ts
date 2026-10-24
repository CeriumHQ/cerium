import type { AgentEvent } from "@cerium/protocol";

import type { TranscriptBlock } from "../transcript/model.ts";
import { describeTool } from "../transcript/tools.ts";

/** What the lead is doing right now, in a few words, shown over the message box while a turn runs. */
export interface LiveActivity {
  readonly verb: string;
  /** The file, command or query it acts on, when the step names one. */
  readonly detail?: string;
  /** When the running turn began, for its clock. */
  readonly since: number;
}

/**
 * The step a running turn is on: its newest unfinished tool call, else whether it's thinking or
 * writing. Undefined until the turn has begun.
 */
export const liveActivity = (
  blocks: ReadonlyArray<TranscriptBlock>,
  events: ReadonlyArray<AgentEvent>,
): LiveActivity | undefined => {
  const since = events.findLast((event) => event.payload._tag === "TurnInput")?.at;
  if (since === undefined) return undefined;
  const tool = blocks.findLast((block) => block.kind === "tool" && block.status === "running");
  if (tool?.kind === "tool") {
    const { verb, detail } = describeTool(tool);
    return { verb, ...(detail ? { detail } : {}), since };
  }
  const last = blocks.at(-1);
  if (last?.kind === "reasoning" && last.streaming) return { verb: "Thinking", since };
  if (last?.kind === "message" && last.streaming) return { verb: "Writing", since };
  return { verb: "Working", since };
};
