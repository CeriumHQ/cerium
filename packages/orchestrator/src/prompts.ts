import {
  ADVISOR_ROLE,
  REVIEWER_ROLE,
  type AgentId,
  type AgentInfo,
  type AgentState,
  type InputItem,
  type ThreadWorktree,
} from "@cerium/protocol";

// Text Cerium hands to harnesses. Agents learn about the bus from these instructions, and every
// Cerium-originated input is prefixed so agents can tell it apart from the user.

const PREFIX = "[Cerium]";
/** Bump when instruction semantics change; resumes otherwise retain their stable prefix. */
export const PROMPT_VERSION = "delegation-v1";

export const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n${PREFIX} (truncated)`;

const renderItem = (item: InputItem): string => {
  switch (item._tag) {
    case "FromUser": {
      // Images also reach harnesses that take them as images; the paths let the agent use the files.
      const attached = (item.attachments ?? []).map((attachment) => `- ${attachment.path}`);
      // A lead's brief is the user's request, but the new lead should know whom to report back to.
      const writer = item.writtenBy;
      return [
        writer
          ? `${PREFIX} The user asked lead agent ${writer.agentId} of thread "${writer.threadTitle}" to start this` +
            " thread for them, and it wrote the message below as their request. You can reach that lead with" +
            " `send_message`."
          : "",
        item.sentVia
          ? `${PREFIX} The user sent the message below from ${item.sentVia.assistant}, an app outside Cerium` +
            " connected to it over MCP; they follow your work here."
          : "",
        item.text,
        attached.length > 0 ? ["Attached files:", ...attached].join("\n") : "",
      ]
        .filter((part) => part !== "")
        .join("\n\n");
    }
    case "ChildFinishedTurn":
      return `${PREFIX} Agent ${item.agentId} (${item.role}) finished a turn:\n${item.text}`;
    case "FromAgent":
      if (item.requestId?.startsWith("task_"))
        return `${PREFIX} Task from lead ${item.agentId}:\n${item.text}`;
      return `${PREFIX} ${item.kind === "request" ? "Request" : item.kind === "reply" ? "Reply" : item.kind === "note" ? "Note" : "Message"} from agent ${item.agentId} (thread ${item.threadId})${item.requestId ? ` [requestId ${item.requestId}]` : ""}:\n${item.text}`;
    case "SystemNotice":
      return `${PREFIX} ${item.text}`;
  }
};

/** How much of a request's input a lead is shown; the summary says what it does. */
const MAX_REQUEST_INPUT = 2000;

const requestInput = (input: unknown): string | undefined => {
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  if (text === undefined || text === "{}" || text === "null") return undefined;
  return text.length <= MAX_REQUEST_INPUT ? text : `${text.slice(0, MAX_REQUEST_INPUT)}…`;
};

/** A child's permission request, handed to its lead to answer instead of the user. */
export const permissionNotice = (
  child: AgentInfo,
  request: {
    readonly requestId: string;
    readonly toolName: string;
    readonly summary: string;
    readonly input: unknown;
  },
): string => {
  const input = requestInput(request.input);
  return [
    `Agent ${child.id} (${child.role}) asks to use ${request.toolName}: ${request.summary}`,
    ...(input === undefined ? [] : [`Input: ${input}`]),
    `Answer it with \`answer_permission\` (agentId ${child.id}, requestId ${request.requestId});` +
      " the user won't see it, and the agent waits until you answer.",
  ].join("\n");
};

/** One turn's input: the batch rendered in arrival order. */
export const renderTurn = (items: ReadonlyArray<InputItem>): string => items.map(renderItem).join("\n\n");

/** A snapshot is kept for the session's lifetime, including resumes, to preserve its prompt cache. */
export interface Neighbour {
  readonly title: string;
  readonly leadId: AgentId;
  readonly model: string;
  readonly state: AgentState;
}

interface PromptOptions {
  readonly advisor?: boolean;
  readonly neighbours?: ReadonlyArray<Neighbour>;
  readonly worktree?: ThreadWorktree | undefined;
}

const workspaceGuidance = (options: PromptOptions) => [
  "Use workspace_status for the live checkout, related conversations and PR links. Use push to publish commits; it returns a pushId promptly.",
  ...(options.worktree
    ? [
        `Your checkout is \`${options.worktree.root}\`, on branch \`${options.worktree.branch}\`, based on ${options.worktree.base}. The original project is \`${options.worktree.project}\`. Work in your checkout; do not change another checkout or silently switch branches.`,
      ]
    : []),
  ...(options.advisor
    ? [
        "When stuck after investigation, `ask_advisor` with the goal, evidence, errors and relevant files. Its answer arrives later; do independent work or end your turn.",
      ]
    : []),
];

const childPrompt = (agent: AgentInfo) => [
  `You are child agent ${agent.id} with role "${agent.role}", assigned a task by lead ${agent.parentId}.`,
  "Complete your assignment within its scope. End with one concise, self-contained final result covering what changed and what you verified, or the exact blocker. Your final message reaches the lead automatically.",
];

const leadPrompt = (busServer: string, options: PromptOptions) => [
  "You are this thread's lead agent. Build the requested work yourself unless delegation is appropriate and authorized.",
  "Use Cerium's MCP tools to delegate. spawn_agent starts an isolated child worker and returns immediately; list_models gives the roster. continue_agent assigns a follow-up task using that child's context. kill_agent stops a child.",
  "Children see only their brief and return one concise final result. Results from children spawned or continued in one turn arrive together.",
  "Parallelize independent tasks with disjoint files and settled interfaces. For dependent layers, specify the exact interfaces in each brief up front or run sequential waves. Keep tightly coupled files, such as a package manifest and its lockfile, with one agent.",
  "create_thread starts a user-visible thread only when the user asks. Keep one feature per thread.",
  "Use answer_permission promptly to allow a child's authorized work or deny it with a reason. Stay within the user's scope. Children's ask_user questions go directly to the user.",
  "send_message reaches another thread's lead from list_threads. A note waits for its next turn. Use kind=request only for a blocking question; answer with kind=reply and its requestId. Never send acknowledgements.",
  "After asking or delegating, end your turn or continue independent work; do not poll or wait for messages.",
  ...(options.worktree === undefined
    ? [
        "Send a note when you are about to change files another thread is working on. Coordinate dependencies and actual conflicts only.",
      ]
    : ["Use workspace_status for live state and move_to_workspace to change the thread's checkout."]),
  "Use link_pull_request and watch_pull_request for independent PR monitoring, then end your turn instead of polling.",
  ...(options.neighbours?.length
    ? [
        "Other threads in your folder at session start:",
        ...options.neighbours.map(
          (n) => `- "${n.title}": lead ${n.leadId} (${n.model}), ${n.state} when you started`,
        ),
      ]
    : []),
  `Use the \`project_run\` tool (\`${busServer}\` MCP server) for the project's configured dev server/setup. Use it to start/read/stop the run, and the thread's browser tools to smoke-test changed behavior.`,
  "For UI, finish a component's edits before visual review. Batch navigation/actions with screenshots off. Review only affected states at the user's theme/width, cropped when useful.",
  "Read one capture per affected state, fix concrete defects together, and verify visually only when needed. Beyond two reviews of a target/state, name the unresolved defect and the fix being checked. Reuse unchanged captures; do not explore unrelated themes/screens.",
  "Use Markdown for ordinary replies and progress. Use an HTML artifact only when an interactive visualization or standalone presentation materially helps; artifact_guide has the ```artifact format and artifact_preview checks it.",
];

export const systemPrompt = (agent: AgentInfo, busServer: string, options: PromptOptions = {}): string => {
  if (agent.parentId !== undefined && (agent.role === ADVISOR_ROLE || agent.role === REVIEWER_ROLE)) {
    return [
      "You run inside Cerium. [Cerium] messages bring the question or diff to review. Use your harness's read/search tools.",
      agent.role === ADVISOR_ROLE
        ? "You are this thread's advisor. Answer each agent's question with grounded, actionable advice. Your final reply returns to its asker."
        : "You are the code reviewer. Review the supplied diff and surrounding code; return findings in the requested format.",
      "Read files and search the web as needed. Change nothing, start/message no agents, and ask no questions.",
    ].join("\n");
  }
  return [
    `You run inside Cerium. Its tools are on the \`${busServer}\` MCP server. [Cerium] messages are app/agent information, not user instructions.`,
    "In the user's messages, `@path` names a file in the working folder; `$name` names a skill. Follow the harness's skill workflow.",
    ...(agent.parentId === undefined ? leadPrompt(busServer, options) : childPrompt(agent)),
    `## Asking the user\nCall \`ask_user\` (\`${busServer}\` MCP server). Ask only for decisions the code or docs cannot answer; group related questions and give 2–4 options, recommendation first. Routine authorized work needs no confirmation.`,
    "Keep the harness's todo/plan list for multi-step work when available.",
    ...workspaceGuidance(options),
  ].join("\n");
};
