import { ARTIFACT_LANGUAGE } from "@cerium/artifacts";
import type { AgentInfo, InputItem } from "@cerium/protocol";

// Text Cerium hands to harnesses. Agents learn about the bus from these instructions, and every
// Cerium-originated input is prefixed so agents can tell it apart from the user.

const PREFIX = "[Cerium]";

export const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n${PREFIX} (truncated)`;

const renderItem = (item: InputItem): string => {
  switch (item._tag) {
    case "FromUser": {
      // Images also reach harnesses that take them as images; the paths let the agent use the files.
      const attached = (item.attachments ?? []).map((attachment) => `- ${attachment.path}`);
      if (attached.length === 0) return item.text;
      return [item.text, ["Attached files:", ...attached].join("\n")]
        .filter((part) => part !== "")
        .join("\n\n");
    }
    case "ChildFinishedTurn":
      return `${PREFIX} Agent ${item.agentId} (${item.role}) finished a turn:\n${item.text}`;
    case "FromAgent":
      return `${PREFIX} Message from agent ${item.agentId} (thread ${item.threadId}):\n${item.text}`;
    case "SystemNotice":
      return `${PREFIX} ${item.text}`;
  }
};

/** One turn's input: the batch rendered in arrival order. */
export const renderTurn = (items: ReadonlyArray<InputItem>): string => items.map(renderItem).join("\n\n");

/**
 * Artifacts only get used when the lead knows when to reach for one and has seen what one looks like,
 * so the prompt names the moments and carries a working example; the full vocabulary stays in the
 * bus's `artifact_guide` tool (architecture §9.1).
 */
const artifacts = (busServer: string) => [
  "",
  "## Visuals in your replies",
  "Cerium renders HTML visuals, called artifacts, inline in the conversation. Write one as a" +
    ` \`\`\`${ARTIFACT_LANGUAGE} code block holding an HTML fragment, with the explanation in markdown around it.`,
  "Reach for one whenever structure carries the point, instead of a markdown table or a long list:",
  "- reporting several pieces of work and how each ended (done, failed, needs the user): a board of cards",
  "- weighing options or approaches against each other: comparison cards",
  "- a sequence: pipeline steps, a flow before and after a change, a timeline",
  "- numbers: test or benchmark results, sizes, durations, counts",
  "Skip it for short answers, a single fact, code, and explanations that read best as prose.",
  `Before your first artifact, call the \`artifact_guide\` tool (\`${busServer}\` MCP server) for the` +
    " building blocks, colour tokens and rules. A minimal artifact:",
  `\`\`\`${ARTIFACT_LANGUAGE}`,
  '<div class="grid">',
  '  <div class="card good"><h3>Parser</h3><p>Fixed; 14 tests pass.</p></div>',
  '  <div class="card warn"><h3>Docs</h3><p>Waiting on your review.</p></div>',
  "</div>",
  "```",
];

export const systemPrompt = (agent: AgentInfo, busServer: string): string => {
  const tools = `the \`${busServer}\` MCP tools`;
  const shared = [
    "You are running inside Cerium, which coordinates agents from several AI providers in one thread.",
    `Messages that start with ${PREFIX} come from Cerium or other agents, not from the user.`,
    `Use ${tools} to talk to other agents: \`list_agents\`, \`send_message\`, \`list_threads\`.`,
    "In the user's messages, `@path` names a file in your working folder (`@path/` a folder), and" +
      " `$name` names a skill: load and follow that skill the way your harness runs skills.",
  ];
  if (agent.parentId === undefined) {
    return [
      ...shared,
      "You are this thread's lead agent.",
      "Delegate with `spawn_agent` (see `list_models` for the models you may use). Spawning returns" +
        " immediately; each child's result arrives later as a message, so end your turn instead of waiting.",
      "Stop a child you no longer need with `kill_agent`.",
      ...artifacts(busServer),
    ].join("\n");
  }
  return [
    ...shared,
    `You are a child agent with the role "${agent.role}", spawned by lead agent ${agent.parentId}.`,
    "Do the task you were given. Your final message of each turn is delivered to the lead, so end with" +
      " a concise, self-contained result.",
  ].join("\n");
};
