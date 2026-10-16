import type { ProviderId } from "@cerium/protocol";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Notice, PermissionCard, Reasoning, SpawnCard, TurnFooter, UserMessage } from "./Blocks.tsx";
import { Markdown } from "./Markdown.tsx";
import type { TranscriptBlock } from "./model.ts";
import { ToolGroup } from "./ToolGroup.tsx";

interface TranscriptProps {
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  readonly agent: { readonly provider: ProviderId; readonly model: string };
  /** Live state of a spawned child, for its card. */
  readonly childState: (childId: string) => "running" | "idle" | "failed";
}

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

/** Cerium's own spawn tool calls are shown by the agent cards they create. */
const isSpawnCall = (block: TranscriptBlock) =>
  block.kind === "tool" && /^mcp__[^_]+__spawn_agent$/.test(block.toolName);

type Item =
  | { readonly kind: "input"; readonly id: string; readonly blocks: ReadonlyArray<TranscriptBlock> }
  | { readonly kind: "header"; readonly id: string }
  | { readonly kind: "tools"; readonly id: string; readonly tools: ReadonlyArray<Block<"tool">> }
  | { readonly kind: "spawns"; readonly id: string; readonly spawns: ReadonlyArray<Block<"spawn">> }
  | { readonly kind: "block"; readonly id: string; readonly block: TranscriptBlock };

/**
 * A permission request shares its id with the tool call it gates. While pending, the approval card
 * stands in for the call's row; once decided, the row alone tells the story.
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
    if (isSpawnCall(block)) return false;
    if (block.kind === "tool") return !pending.has(block.id.replace(/^tool:/, ""));
    if (block.kind === "permission") {
      return block.resolution === undefined || !toolIds.has(block.id.replace(/^permission:/, ""));
    }
    return true;
  });
};

/** Turns blocks into display items: user inputs, a header per response, and grouped tools and spawns. */
const layout = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<Item> => {
  const items: Array<Item> = [];
  for (const block of visible(blocks)) {
    const last = items.at(-1);
    if (block.kind === "user") {
      if (last?.kind === "input") items[items.length - 1] = { ...last, blocks: [...last.blocks, block] };
      else items.push({ kind: "input", id: block.id, blocks: [block] });
      continue;
    }
    // One header per response: only the user's own messages start a new one. Results from child
    // agents arrive mid-response and stay inside it.
    if (last === undefined || last.kind === "input") items.push({ kind: "header", id: `header:${block.id}` });
    const previous = items.at(-1);
    if (block.kind === "tool") {
      if (previous?.kind === "tools")
        items[items.length - 1] = { ...previous, tools: [...previous.tools, block] };
      else items.push({ kind: "tools", id: block.id, tools: [block] });
    } else if (block.kind === "spawn") {
      if (previous?.kind === "spawns")
        items[items.length - 1] = { ...previous, spawns: [...previous.spawns, block] };
      else items.push({ kind: "spawns", id: block.id, spawns: [block] });
    } else {
      items.push({ kind: "block", id: block.id, block });
    }
  }
  return items;
};

export function Transcript({ blocks, agent, childState }: TranscriptProps) {
  const roles = new Map(
    blocks.flatMap((block) => (block.kind === "spawn" ? [[block.childId, block.role] as const] : [])),
  );
  const roleOf = (agentId: string) => roles.get(agentId) ?? "An agent";

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-[46rem] flex-col gap-3 px-8 pt-8 pb-40">
        {layout(blocks).map((item) => {
          switch (item.kind) {
            case "input":
              return (
                <div key={item.id} className="flex flex-col items-end gap-2 py-3">
                  {item.blocks.map((block) =>
                    block.kind === "user" ? <UserMessage key={block.id} block={block} /> : null,
                  )}
                </div>
              );
            case "header":
              return <ResponseHeader key={item.id} agent={agent} />;
            case "tools":
              return <ToolGroup key={item.id} tools={item.tools} />;
            case "spawns":
              return (
                <div key={item.id} className="flex flex-wrap gap-1.5">
                  {item.spawns.map((spawn) => (
                    <SpawnCard key={spawn.id} block={spawn} state={childState(spawn.childId)} />
                  ))}
                </div>
              );
            case "block":
              return <ResponseBlock key={item.id} block={item.block} roleOf={roleOf} />;
          }
        })}
      </div>
    </ScrollArea>
  );
}

function ResponseHeader({ agent }: { agent: TranscriptProps["agent"] }) {
  return (
    <div className="flex items-center gap-2 pt-2 text-xs text-fg-tertiary">
      <span className="grid size-5 place-items-center rounded-md border border-line-subtle bg-surface-raised text-fg-primary">
        <ProviderLogo provider={agent.provider} size={11} />
      </span>
      <span className="font-medium text-fg-secondary">{agent.model}</span>
    </div>
  );
}

function ResponseBlock({ block, roleOf }: { block: TranscriptBlock; roleOf: (agentId: string) => string }) {
  switch (block.kind) {
    case "notice":
      return <Notice block={block} roleOf={roleOf} />;
    case "message":
      return (
        <div className="select-text">
          <Markdown text={block.text} streaming={block.streaming} />
        </div>
      );
    case "reasoning":
      return <Reasoning block={block} />;
    case "permission":
      return <PermissionCard block={block} />;
    case "turnEnd":
      return <TurnFooter block={block} />;
    case "error":
      return <p className="text-[13px] text-fg-secondary">{block.message}</p>;
    default:
      return null;
  }
}
