import type { AgentInfo, InputItem } from "@cerium/protocol";

// Text Cerium hands to harnesses. Agents learn about the bus from these instructions, and every
// Cerium-originated input is prefixed so agents can tell it apart from the user.

const PREFIX = "[Cerium]";

export const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n${PREFIX} (truncated)`;

const renderItem = (item: InputItem): string => {
  switch (item._tag) {
    case "FromUser":
      return item.text;
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

export const systemPrompt = (agent: AgentInfo, busServer: string): string => {
  const tools = `the \`${busServer}\` MCP tools`;
  const shared = [
    "You are running inside Cerium, which coordinates agents from several AI providers in one thread.",
    `Messages that start with ${PREFIX} come from Cerium or other agents, not from the user.`,
    `Use ${tools} to talk to other agents: \`list_agents\`, \`send_message\`, \`list_threads\`.`,
  ];
  if (agent.parentId === undefined) {
    return [
      ...shared,
      "You are this thread's lead agent.",
      "Delegate with `spawn_agent` (see `list_models` for the models you may use). Spawning returns" +
        " immediately; each child's result arrives later as a message, so end your turn instead of waiting.",
      "Stop a child you no longer need with `kill_agent`.",
    ].join("\n");
  }
  return [
    ...shared,
    `You are a child agent with the role "${agent.role}", spawned by lead agent ${agent.parentId}.`,
    "Do the task you were given. Your final message of each turn is delivered to the lead, so end with" +
      " a concise, self-contained result.",
  ].join("\n");
};
