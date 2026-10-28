import type { ModelSpeed, ProviderId, ReasoningEffort } from "@cerium/protocol";

import { isAnswerNotice, type RoutedDecision, type TranscriptBlock } from "./model.ts";
import { isPushCall } from "./push.ts";
import { outputText, type ToolBlock } from "./tools.ts";

// How a thread's blocks become what the transcript shows: inputs, a header per response, tool calls
// grouped into runs, and the end of each response with the text it can copy.

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

export type Item =
  | { readonly kind: "input"; readonly id: string; readonly blocks: ReadonlyArray<TranscriptBlock> }
  /**
   * The start of a response, with the model it ran on (absent when the thread never said) and, for
   * an agent on Auto, what the effort router decided for it.
   */
  | {
      readonly kind: "header";
      readonly id: string;
      /** The harness it ran on, where the thread said; else the lead's own. */
      readonly provider?: ProviderId;
      readonly model?: string;
      readonly routed?: RoutedDecision;
    }
  /**
   * Where the user switched the agent's model, or just its effort or speed, or handed it to another
   * harness.
   */
  | {
      readonly kind: "switch";
      readonly id: string;
      readonly provider?: ProviderId;
      readonly model: string;
      readonly effort?: ReasoningEffort;
      readonly speed?: ModelSpeed;
      readonly change: "model" | "effort" | "speed" | "handoff";
    }
  /** Where the thread came from: a session the user had with the harness outside Cerium. */
  | { readonly kind: "imported"; readonly id: string; readonly block: Block<"imported"> }
  /** The effort router's decision for a turn inside a response, such as one a child's result began. */
  | { readonly kind: "routed"; readonly id: string; readonly decision: RoutedDecision }
  | { readonly kind: "tools"; readonly id: string; readonly tools: ReadonlyArray<Block<"tool">> }
  | { readonly kind: "spawns"; readonly id: string; readonly spawns: ReadonlyArray<Block<"spawn">> }
  /** A request to start an agent that waits for the user's approval, which leaves no card yet. */
  | { readonly kind: "spawnAsk"; readonly id: string; readonly call: Block<"tool"> }
  /** A push through Cerium's `push` tool, shown with its checks rather than as a row of a run. */
  | { readonly kind: "push"; readonly id: string; readonly call: Block<"tool"> }
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

// Every update asks these of every call; most are a harness's own tools, which the prefix rules out
// before the pattern runs.
const isSpawnCall = (block: TranscriptBlock): block is ToolBlock =>
  block.kind === "tool" &&
  block.toolName.startsWith("mcp__") &&
  /^mcp__[^_]+__spawn_agent$/.test(block.toolName);

const isAskCall = (block: TranscriptBlock): block is ToolBlock =>
  block.kind === "tool" &&
  block.toolName.startsWith("mcp__") &&
  /^mcp__[^_]+__ask_user$/.test(block.toolName);

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
  // Requests by the block id of the call each gates, so a long thread's thousands of calls are looked
  // up by their own ids rather than each renamed to compare.
  const pending = new Set<string>();
  const decided = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind !== "permission") continue;
    const call = block.id.replace(/^permission:/, "tool:");
    if (block.resolution === undefined) pending.add(call);
    else decided.set(call, block.id);
  }
  /** The decided requests whose call has a row. */
  const told = new Set<string>();
  if (decided.size > 0) {
    for (const block of blocks) {
      const request = block.kind === "tool" ? decided.get(block.id) : undefined;
      if (request !== undefined) told.add(request);
    }
  }
  return blocks.filter((block) => {
    if (isSpawnCall(block) && block.status !== "error" && spawnResult(block) !== "pendingApproval") {
      return false;
    }
    if (isAskCall(block) && block.status !== "error") return false;
    if (block.kind === "tool") return !pending.has(block.id);
    if (block.kind === "permission") return block.resolution === undefined || !told.has(block.id);
    return true;
  });
};

/** Turns blocks into display items: user inputs, a header per response, and grouped tools and spawns. */
export const layout = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<Item> => {
  const items: Array<Item> = [];
  // What the agent has said since the user last spoke: what its end-of-response button copies.
  let said: Array<string> = [];
  // The model the agent runs on, and its harness, for the header of the response that starts next.
  let model: string | undefined;
  let provider: ProviderId | undefined;
  let headerDue = true;
  // The router decides before the turn's input arrives, so its word waits for the response's header.
  let routed: Block<"routed"> | undefined;
  for (const block of visible(blocks)) {
    const last = items.at(-1);
    if (block.kind === "routed") {
      routed = block;
      continue;
    }
    if (block.kind === "model") {
      model = block.model;
      provider = block.provider ?? provider;
      if (block.change !== "start") {
        items.push({
          kind: "switch",
          id: block.id,
          ...(provider ? { provider } : {}),
          model: block.model,
          ...(block.effort ? { effort: block.effort } : {}),
          ...(block.speed ? { speed: block.speed } : {}),
          change: block.change,
        });
      }
      continue;
    }
    if (block.kind === "imported") {
      items.push({ kind: "imported", id: block.id, block });
      continue;
    }
    // A compaction the user asked for between responses begins none of its own.
    if (block.kind === "compacted" && headerDue) {
      items.push({ kind: "block", id: block.id, block });
      continue;
    }
    if (block.kind === "replaced") {
      said = [];
      headerDue = true;
      routed = undefined;
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
      items.push({
        kind: "header",
        id: `header:${block.id}`,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(routed ? { routed: routed.decision } : {}),
      });
      headerDue = false;
      routed = undefined;
    } else if (routed !== undefined) {
      items.push({ kind: "routed", id: routed.id, decision: routed.decision });
      routed = undefined;
    }
    const previous = items.at(-1);
    if (isSpawnCall(block) && block.status !== "error") {
      items.push({ kind: "spawnAsk", id: block.id, call: block });
    } else if (block.kind === "tool" && block.status !== "error" && isPushCall(block)) {
      items.push({ kind: "push", id: block.id, call: block });
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

/** When each of a run's steps began and ended: its calls' and its thoughts'. */
export const runTimings = (steps: ReadonlyArray<Item>) =>
  steps.flatMap<{ readonly startedAt?: number; readonly endedAt?: number }>((step) =>
    step.kind === "tools"
      ? step.tools
      : step.kind === "block" && step.block.kind === "reasoning"
        ? [step.block]
        : [],
  );

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
    case "push":
      return item.call.status === "running";
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

/**
 * What the effort router decided for a response that hasn't started: its last decision, unless a
 * response has begun since.
 */
export const pendingRouted = (blocks: ReadonlyArray<TranscriptBlock>): RoutedDecision | undefined => {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.kind === "routed") return block.decision;
    if (block.kind !== "user" && block.kind !== "model" && !isAnswerNotice(block)) return undefined;
  }
  return undefined;
};

/** The model the agent runs on at the end of the thread, which a response about to start runs on. */
export const currentModel = (blocks: ReadonlyArray<TranscriptBlock>): string | undefined =>
  blocks.findLast((block) => block.kind === "model")?.model;
