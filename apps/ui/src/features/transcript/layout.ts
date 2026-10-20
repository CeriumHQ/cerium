import type { ReasoningEffort } from "@cerium/protocol";

import { isAnswerNotice, type TranscriptBlock } from "./model.ts";
import { outputText, type ToolBlock } from "./tools.ts";

// How a thread's blocks become what the transcript shows: inputs, a header per response, tool calls
// grouped into runs, and the end of each response with the text it can copy.

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

export type Item =
  | { readonly kind: "input"; readonly id: string; readonly blocks: ReadonlyArray<TranscriptBlock> }
  /** The start of a response, with the model it ran on (absent when the thread never said). */
  | { readonly kind: "header"; readonly id: string; readonly model?: string }
  /** Where the user switched the agent's model, or just its effort. */
  | {
      readonly kind: "switch";
      readonly id: string;
      readonly model: string;
      readonly effort?: ReasoningEffort;
      readonly change: "model" | "effort";
    }
  | { readonly kind: "tools"; readonly id: string; readonly tools: ReadonlyArray<Block<"tool">> }
  | { readonly kind: "spawns"; readonly id: string; readonly spawns: ReadonlyArray<Block<"spawn">> }
  /** A request to start an agent that waits for the user's approval, which leaves no card yet. */
  | { readonly kind: "spawnAsk"; readonly id: string; readonly call: Block<"tool"> }
  | { readonly kind: "block"; readonly id: string; readonly block: TranscriptBlock }
  /** The end of a response, with the response's text for its copy button. */
  | { readonly kind: "turnEnd"; readonly id: string; readonly block: Block<"turnEnd">; readonly text: string }
  | { readonly kind: "run"; readonly id: string; readonly steps: ReadonlyArray<Item> }
  /** The turns a rewind replaced, laid out like the conversation, with how many of the user's messages began them. */
  | {
      readonly kind: "replaced";
      readonly id: string;
      readonly items: ReadonlyArray<Item>;
      readonly turns: number;
      /** The files a restore put back as they were before these turns. */
      readonly files?: number;
    };

const isSpawnCall = (block: TranscriptBlock): block is ToolBlock =>
  block.kind === "tool" && /^mcp__[^_]+__spawn_agent$/.test(block.toolName);

const isAskCall = (block: TranscriptBlock): block is ToolBlock =>
  block.kind === "tool" && /^mcp__[^_]+__ask_user$/.test(block.toolName);

/** How a spawn call turned out, from its result: the agent started, or the user must approve it first. */
const spawnResult = (call: ToolBlock): "spawned" | "pendingApproval" | undefined => {
  try {
    const status: unknown = (JSON.parse(outputText(call.output)) as { status?: unknown }).status;
    return status === "spawned" || status === "pendingApproval" ? status : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A permission request shares its id with the tool call it gates. While pending, the approval card
 * stands in for the call's row; once decided, the row alone tells the story.
 *
 * Cerium's own spawn calls are shown by the agent cards they create. That leaves out the ones that
 * create none: a refused call keeps its row, which says why, and a request waiting for approval gets
 * a line of its own. Likewise a question shows as its card, and only a refused `ask_user` call as a row.
 */
const visible = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<TranscriptBlock> => {
  const pending = new Set(
    blocks.flatMap((block) =>
      block.kind === "permission" && block.resolution === undefined
        ? [block.id.replace(/^permission:/, "")]
        : [],
    ),
  );
  const toolIds = new Set(
    blocks.flatMap((block) => (block.kind === "tool" ? [block.id.replace(/^tool:/, "")] : [])),
  );
  return blocks.filter((block) => {
    if (isSpawnCall(block) && block.status !== "error" && spawnResult(block) !== "pendingApproval") {
      return false;
    }
    if (isAskCall(block) && block.status !== "error") return false;
    if (block.kind === "tool") return !pending.has(block.id.replace(/^tool:/, ""));
    if (block.kind === "permission") {
      return block.resolution === undefined || !toolIds.has(block.id.replace(/^permission:/, ""));
    }
    return true;
  });
};

/** Turns blocks into display items: user inputs, a header per response, and grouped tools and spawns. */
export const layout = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<Item> => {
  const items: Array<Item> = [];
  // What the agent has said since the user last spoke: what its end-of-response button copies.
  let said: Array<string> = [];
  // The model the agent runs on, for the header of the response that starts next.
  let model: string | undefined;
  let headerDue = true;
  for (const block of visible(blocks)) {
    const last = items.at(-1);
    if (block.kind === "model") {
      model = block.model;
      if (block.change !== "start") {
        items.push({
          kind: "switch",
          id: block.id,
          model: block.model,
          ...(block.effort ? { effort: block.effort } : {}),
          change: block.change,
        });
      }
      continue;
    }
    if (block.kind === "replaced") {
      said = [];
      headerDue = true;
      items.push({
        kind: "replaced",
        id: block.id,
        items: layout(block.blocks),
        turns: block.blocks.filter((each) => each.kind === "user").length,
        ...(block.files === undefined ? {} : { files: block.files }),
      });
      continue;
    }
    if (block.kind === "user") {
      said = [];
      headerDue = true;
      if (last?.kind === "input") items[items.length - 1] = { ...last, blocks: [...last.blocks, block] };
      else items.push({ kind: "input", id: block.id, blocks: [block] });
      continue;
    }
    // The user's answer to a question shows on the question; what the agent does with it is a new
    // response, as after a message.
    if (isAnswerNotice(block)) {
      said = [];
      headerDue = true;
      continue;
    }
    // One header per response: only the user's own messages start a new one. Results from child
    // agents arrive mid-response and stay inside it.
    if (headerDue) {
      items.push({ kind: "header", id: `header:${block.id}`, ...(model ? { model } : {}) });
      headerDue = false;
    }
    const previous = items.at(-1);
    if (isSpawnCall(block) && block.status !== "error") {
      items.push({ kind: "spawnAsk", id: block.id, call: block });
    } else if (block.kind === "tool") {
      if (previous?.kind === "tools")
        items[items.length - 1] = { ...previous, tools: [...previous.tools, block] };
      else items.push({ kind: "tools", id: block.id, tools: [block] });
    } else if (block.kind === "spawn") {
      if (previous?.kind === "spawns")
        items[items.length - 1] = { ...previous, spawns: [...previous.spawns, block] };
      else items.push({ kind: "spawns", id: block.id, spawns: [block] });
    } else if (block.kind === "turnEnd") {
      items.push({ kind: "turnEnd", id: block.id, block, text: said.join("\n\n") });
      said = [];
    } else {
      if (block.kind === "message") said.push(block.text);
      items.push({ kind: "block", id: block.id, block });
    }
  }
  return fold(items);
};

const isStep = (item: Item) =>
  item.kind === "tools" || (item.kind === "block" && item.block.kind === "reasoning");

/** Folds each stretch of tool calls, and the reasoning between them, into one run. */
const fold = (items: ReadonlyArray<Item>): ReadonlyArray<Item> => {
  const folded: Array<Item> = [];
  let steps: Array<Item> = [];
  const flush = () => {
    // Reasoning alone is already one line.
    if (steps.some((step) => step.kind === "tools"))
      folded.push({ kind: "run", id: `run:${steps[0]!.id}`, steps });
    else folded.push(...steps);
    steps = [];
  };
  for (const item of items) {
    if (isStep(item)) {
      steps.push(item);
    } else {
      flush();
      folded.push(item);
    }
  }
  flush();
  return folded;
};

/** Whether the end of the transcript already shows the agent at work, or waiting on the user. */
export const showsProgress = (item: Item | undefined): boolean => {
  switch (item?.kind) {
    case "run":
      return showsProgress(item.steps.at(-1));
    case "tools":
      return item.tools.some((tool) => tool.status === "running");
    case "block":
      return (
        ((item.block.kind === "message" || item.block.kind === "reasoning") && item.block.streaming) ||
        ((item.block.kind === "permission" || item.block.kind === "question") &&
          item.block.resolution === undefined)
      );
    default:
      return false;
  }
};

/** The model the agent runs on at the end of the thread, which a response about to start runs on. */
export const currentModel = (blocks: ReadonlyArray<TranscriptBlock>): string | undefined =>
  blocks.findLast((block) => block.kind === "model")?.model;
