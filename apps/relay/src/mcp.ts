import {
  AssistantRequest,
  MAX_ASSISTANT_PROMPT,
  MAX_THREAD_TITLE,
  type AssistantResult,
  type DeviceId,
  type ThreadId,
} from "@cerium/protocol";
import { Option, Schema } from "effect";

// The relay's MCP endpoint (Streamable HTTP, answering with plain JSON): the tools an assistant
// the user connected calls, each answered from the account's cloud copy of its threads or by one
// of its desktops. What reaches a desktop is an `AssistantRequest`; the desktop decides whether to
// do it. Nothing here keeps state between requests, so there is no session to resume.

/** Newest first; a client asking for another is answered with the newest. */
export const MCP_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = [
  "Cerium runs coding agents (Claude Code, Codex, Cursor and others) on the user's own computers.",
  "Start a thread with create_thread when the user asks you to start work there, one thread per task;",
  "its lead agent takes your prompt as the user's request, so make it stand alone.",
  "list_projects names the folders it can work in, list_threads and read_thread show how threads are",
  "going, and send_message adds to one. Threads run on the user's computer, which must be online with",
  "assistants turned on in Cerium's settings.",
].join(" ");

/** One of the account's desktops, as the tools see it. */
export interface Computer {
  readonly id: DeviceId;
  readonly name: string;
  readonly online: boolean;
  /** Online, and its user turned assistants on. */
  readonly takesAssistants: boolean;
}

/** A thread of the account, from the cloud copy. */
export interface ThreadSummary {
  readonly machine: DeviceId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly project?: string;
  readonly status: "working" | "waiting on the user" | "failed" | "idle";
  readonly lastActiveAt: number;
}

/** One message of a thread, from the cloud copy. */
export interface ThreadMessage {
  readonly from: "user" | "lead";
  readonly text: string;
  readonly at: number;
}

/** What the tools reach: the account's object implements it. */
export interface AssistantDesk {
  computers(): ReadonlyArray<Computer>;
  threads(): ReadonlyArray<ThreadSummary>;
  /** The thread's latest messages, oldest first. */
  messages(machine: DeviceId, threadId: ThreadId): ReadonlyArray<ThreadMessage>;
  /** Asks a desktop that takes assistants; resolves with its answer or why there was none. */
  call(computer: Computer, request: AssistantRequest): Promise<AssistantResult>;
}

// ---- The cloud copy, read ------------------------------------------------------------------

interface StoredOverview {
  readonly thread?: {
    readonly id?: string;
    readonly title?: string;
    readonly cwd?: string;
    readonly worktree?: { readonly project?: string };
    readonly archivedAt?: number;
    readonly updatedAt?: number;
  };
  readonly agents?: ReadonlyArray<{
    readonly id?: string;
    readonly parentId?: string;
    readonly state?: string;
    readonly updatedAt?: number;
  }>;
  readonly awaitingApproval?: boolean;
}

/** A thread as the tools list it, from the overview its machine stored; none for an archived one. */
export const threadSummary = (machine: DeviceId, overviewJson: string): ThreadSummary | undefined => {
  let overview: StoredOverview;
  try {
    overview = JSON.parse(overviewJson) as StoredOverview;
  } catch {
    return undefined;
  }
  const thread = overview.thread;
  if (thread?.id === undefined || thread.archivedAt !== undefined) return undefined;
  const agents = overview.agents ?? [];
  const lead = agents.find((agent) => agent.parentId === undefined);
  const status: ThreadSummary["status"] = overview.awaitingApproval
    ? "waiting on the user"
    : agents.some((agent) => agent.state === "running" || agent.state === "queued")
      ? "working"
      : lead?.state === "failed"
        ? "failed"
        : "idle";
  const project = thread.worktree?.project ?? thread.cwd;
  return {
    machine,
    threadId: thread.id as ThreadId,
    title: thread.title ?? "Untitled thread",
    ...(project === undefined ? {} : { project }),
    status,
    lastActiveAt: Math.max(thread.updatedAt ?? 0, ...agents.map((agent) => agent.updatedAt ?? 0)),
  };
};

/** The longest message `read_thread` hands back whole. */
const MESSAGE_CHARS = 4_000;
/** How many of a thread's latest messages `read_thread` hands back. */
export const THREAD_MESSAGES = 8;

interface StoredMessage {
  readonly _tag?: string;
  readonly id?: string;
  readonly text?: string;
}

interface StoredEvent {
  readonly agentId?: string;
  readonly at?: number;
  readonly payload?: {
    readonly _tag?: string;
    readonly text?: string;
    readonly message?: StoredMessage;
    readonly items?: ReadonlyArray<StoredMessage>;
  };
}

/**
 * The user's messages and the lead's replies among a thread's events, the latest `THREAD_MESSAGES`. A
 * user's message is in the `TurnInput` that delivered it, and in its `MessageQueued` when it waited:
 * told once, by its id.
 */
export const threadMessages = (
  overviewJson: string,
  events: ReadonlyArray<unknown>,
): ReadonlyArray<ThreadMessage> => {
  let lead: string | undefined;
  try {
    const overview = JSON.parse(overviewJson) as StoredOverview;
    lead = overview.agents?.find((agent) => agent.parentId === undefined)?.id;
  } catch {
    return [];
  }
  const cut = (text: string) =>
    text.length <= MESSAGE_CHARS ? text : `${text.slice(0, MESSAGE_CHARS)}… (cut short)`;
  const told = new Set<string>();
  const fromUser = (message: StoredMessage | undefined, at: number): ReadonlyArray<ThreadMessage> => {
    if (message?._tag !== "FromUser" || typeof message.text !== "string") return [];
    if (message.id !== undefined) {
      if (told.has(message.id)) return [];
      told.add(message.id);
    }
    return [{ from: "user", text: cut(message.text), at }];
  };
  return (events as ReadonlyArray<StoredEvent>)
    .flatMap((event): ReadonlyArray<ThreadMessage> => {
      if (event.agentId !== lead) return [];
      const payload = event.payload;
      const at = event.at ?? 0;
      switch (payload?._tag) {
        case "MessageCompleted":
          return typeof payload.text === "string" && payload.text.trim() !== ""
            ? [{ from: "lead", text: cut(payload.text), at }]
            : [];
        case "MessageQueued":
          return fromUser(payload.message, at);
        case "TurnInput":
          return (payload.items ?? []).flatMap((item) => fromUser(item, at));
        default:
          return [];
      }
    })
    .slice(-THREAD_MESSAGES);
};

// ---- Tools ---------------------------------------------------------------------------------

const computerParam = {
  computer: {
    type: "string",
    description:
      "The computer's name or id from list_computers. Needed only when more than one takes assistants.",
  },
} as const;

export const TOOLS = [
  {
    name: "list_computers",
    description:
      "List the computers in the user's Cerium account: whether each is online and lets assistants start threads.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_projects",
    description:
      "List the project folders a computer keeps, most recently used first. create_thread works in one of them.",
    inputSchema: { type: "object", properties: { ...computerParam } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_models",
    description: "List the models a thread can start on, by the alias create_thread takes.",
    inputSchema: { type: "object", properties: { ...computerParam } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_thread",
    description:
      "Start a new thread on the user's computer. Its lead agent takes `prompt` as the user's request and" +
      " works on it in `project`; the user follows it in Cerium. Start one thread per task. Returns at once.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The lead's first message: the whole task. It sees nothing of this conversation, so make it stand alone.",
          maxLength: MAX_ASSISTANT_PROMPT,
        },
        project: {
          type: "string",
          description:
            "A project's path or folder name from list_projects. Leave it out for a chat that works in no folder.",
        },
        title: { type: "string", description: "A few words naming the thread.", maxLength: MAX_THREAD_TITLE },
        model: { type: "string", description: "A model alias from list_models; leave out for the default." },
        worktree: {
          type: "boolean",
          description: "Run it in a git worktree of its own, apart from other threads' changes.",
        },
        ...computerParam,
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_threads",
    description:
      "List the user's threads, most recently active first, with each one's status: working, waiting on the user, failed or idle.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Only threads whose title or project contains this." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "At most this many; 20 by default." },
        ...computerParam,
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_thread",
    description: "Read a thread's latest messages: the user's requests and its lead agent's replies.",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string", description: "The thread's id from list_threads." } },
      required: ["thread_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "send_message",
    description:
      "Send a thread's lead agent a message, as if the user typed it there: a follow-up, a correction, an answer.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "The thread's id from list_threads." },
        text: { type: "string", maxLength: MAX_ASSISTANT_PROMPT },
      },
      required: ["thread_id", "text"],
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

/** A tool's answer: text for the model, and the same as JSON for clients that read it. */
interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

const answer = (value: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const failure = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * The computer a call goes to: the one named, or the only one taking assistants. Refused with
 * what the user can do about it otherwise.
 */
export const pickComputer = (
  computers: ReadonlyArray<Computer>,
  wanted: string | undefined,
): Computer | string => {
  if (computers.length === 0)
    return "This Cerium account has no computers. Install Cerium on one and sign in to it.";
  if (wanted !== undefined && wanted.trim() !== "") {
    const key = wanted.trim().toLowerCase();
    const named = computers.find((each) => each.id === wanted.trim() || each.name.toLowerCase() === key);
    if (named === undefined)
      return `No computer is called "${wanted}". The account has: ${computers.map((each) => each.name).join(", ")}.`;
    if (!named.online) return `${named.name} isn't online. Cerium needs to be running on it.`;
    if (!named.takesAssistants)
      return `${named.name} doesn't let assistants start threads. The user can turn that on in Cerium: Settings → Assistants.`;
    return named;
  }
  const taking = computers.filter((each) => each.takesAssistants);
  const [only] = taking;
  if (only !== undefined && taking.length === 1) return only;
  if (taking.length > 1)
    return `Several computers take assistants: ${taking.map((each) => each.name).join(", ")}. Name one as \`computer\`.`;
  return computers.some((each) => each.online)
    ? "None of the user's online computers lets assistants start threads. The user can turn that on in Cerium: Settings → Assistants."
    : "None of the user's computers is online. Cerium needs to be running on one.";
};

const Args = {
  computer: Schema.Struct({ computer: Schema.optionalKey(Schema.String) }),
  createThread: Schema.Struct({
    prompt: Schema.String,
    project: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    worktree: Schema.optionalKey(Schema.Boolean),
    computer: Schema.optionalKey(Schema.String),
  }),
  listThreads: Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
    computer: Schema.optionalKey(Schema.String),
  }),
  readThread: Schema.Struct({ thread_id: Schema.String }),
  sendMessage: Schema.Struct({ thread_id: Schema.String, text: Schema.String }),
};

const decodeArgs = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, args: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(args ?? {}));

const decodeRequest = Schema.decodeUnknownOption(AssistantRequest);

const badArguments = (tool: string) => failure(`Those aren't arguments ${tool} takes. See its input schema.`);

/** A desktop's answer as a tool's. */
const fromDesktop = (computer: Computer, result: AssistantResult): ToolResult => {
  switch (result._tag) {
    case "Refused":
      return failure(result.message);
    case "Projects":
      return answer({ computer: computer.name, projects: result.projects });
    case "Models":
      return answer({ computer: computer.name, models: result.models });
    case "ThreadStarted":
      return answer({
        computer: computer.name,
        threadId: result.threadId,
        title: result.title,
        note: "The thread started; the user follows it in Cerium. read_thread shows its progress.",
      });
    case "Sent":
      return answer({ computer: computer.name, sent: true });
  }
};

const ask = async (
  desk: AssistantDesk,
  wanted: string | undefined,
  request: unknown,
): Promise<ToolResult> => {
  const decoded = Option.getOrUndefined(decodeRequest(request));
  if (decoded === undefined) return failure("That request is too long, or missing what it needs.");
  const computer = pickComputer(desk.computers(), wanted);
  if (typeof computer === "string") return failure(computer);
  return fromDesktop(computer, await desk.call(computer, decoded));
};

/** The thread an assistant names, with the computer it lives on. */
const findThread = (desk: AssistantDesk, threadId: string) => {
  const thread = desk.threads().find((each) => each.threadId === threadId);
  if (thread === undefined) return "No thread has that id. list_threads shows the user's threads.";
  const computer = desk.computers().find((each) => each.id === thread.machine);
  return computer === undefined
    ? "That thread's computer is no longer in the account."
    : { thread, computer };
};

export const callTool = async (desk: AssistantDesk, name: string, args: unknown): Promise<ToolResult> => {
  switch (name as ToolName) {
    case "list_computers":
      return answer({
        computers: desk.computers().map(({ id, name, online, takesAssistants }) => ({
          id,
          name,
          online,
          takesAssistants,
        })),
      });
    case "list_projects":
    case "list_models": {
      const parsed = decodeArgs(Args.computer, args);
      if (parsed === undefined) return badArguments(name);
      return ask(desk, parsed.computer, { _tag: name === "list_projects" ? "ListProjects" : "ListModels" });
    }
    case "create_thread": {
      const parsed = decodeArgs(Args.createThread, args);
      if (parsed === undefined) return badArguments(name);
      const { computer, ...request } = parsed;
      return ask(desk, computer, { _tag: "StartThread", ...request });
    }
    case "list_threads": {
      const parsed = decodeArgs(Args.listThreads, args);
      if (parsed === undefined) return badArguments(name);
      const computers = desk.computers();
      const names = new Map(computers.map((each) => [each.id as string, each.name]));
      let only: DeviceId | undefined;
      if (parsed.computer !== undefined) {
        const key = parsed.computer.trim().toLowerCase();
        only = computers.find((each) => each.id === parsed.computer || each.name.toLowerCase() === key)?.id;
        if (only === undefined) return failure(`No computer is called "${parsed.computer}".`);
      }
      const query = parsed.query?.trim().toLowerCase();
      const threads = desk
        .threads()
        .filter((each) => only === undefined || each.machine === only)
        .filter(
          (each) =>
            query === undefined ||
            query === "" ||
            each.title.toLowerCase().includes(query) ||
            (each.project ?? "").toLowerCase().includes(query),
        )
        .toSorted((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, parsed.limit ?? 20)
        .map(({ machine, lastActiveAt, ...rest }) => ({
          ...rest,
          computer: names.get(machine) ?? machine,
          lastActiveAt: new Date(lastActiveAt).toISOString(),
        }));
      return answer({ threads });
    }
    case "read_thread": {
      const parsed = decodeArgs(Args.readThread, args);
      if (parsed === undefined) return badArguments(name);
      const found = findThread(desk, parsed.thread_id);
      if (typeof found === "string") return failure(found);
      return answer({
        title: found.thread.title,
        status: found.thread.status,
        computer: found.computer.name,
        messages: desk.messages(found.thread.machine, found.thread.threadId).map(({ at, ...rest }) => ({
          ...rest,
          at: new Date(at).toISOString(),
        })),
      });
    }
    case "send_message": {
      const parsed = decodeArgs(Args.sendMessage, args);
      if (parsed === undefined) return badArguments(name);
      const found = findThread(desk, parsed.thread_id);
      if (typeof found === "string") return failure(found);
      return ask(desk, found.computer.id, {
        _tag: "SendToThread",
        threadId: found.thread.threadId,
        text: parsed.text,
      });
    }
    default:
      return failure(`There's no tool called ${name}.`);
  }
};

// ---- JSON-RPC ------------------------------------------------------------------------------

type Id = string | number | null;

const rpcError = (id: Id, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });

const isId = (id: unknown): id is string | number => typeof id === "string" || typeof id === "number";

/** One JSON-RPC message's answer; none for a notification, or a response from the client. */
const handleOne = async (message: unknown, desk: AssistantDesk): Promise<unknown> => {
  if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0")
    return rpcError(null, -32600, "Not a JSON-RPC 2.0 message.");
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof method !== "string") return undefined;
  if (!isId(id)) return undefined;
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case "initialize": {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : undefined;
      return rpcResult(id, {
        protocolVersion: asked !== undefined && MCP_PROTOCOLS.includes(asked) ? asked : MCP_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cerium", title: "Cerium", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      if (typeof p.name !== "string") return rpcError(id, -32602, "tools/call needs a tool's name.");
      return rpcResult(id, await callTool(desk, p.name, p.arguments));
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Cerium doesn't offer ${method}.`);
  }
};

/**
 * A POST to the MCP endpoint: one message or a batch. Answers with what to send back, or none when
 * it held only notifications and responses, which are acknowledged with 202 and no body.
 */
export const handleMcp = async (body: unknown, desk: AssistantDesk): Promise<unknown> => {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, -32600, "An empty batch.");
    const answers = (await Promise.all(body.map((message) => handleOne(message, desk)))).filter(
      (each) => each !== undefined,
    );
    return answers.length === 0 ? undefined : answers;
  }
  return handleOne(body, desk);
};

/** A body that isn't JSON. */
export const parseError = rpcError(null, -32700, "The body isn't JSON.");
