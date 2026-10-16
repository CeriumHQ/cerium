import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";

// A realistic lead transcript for building the transcript components: an Opus lead investigating a
// flaky test, delegating PR checks to two Muse scouts, then waiting for approval to run the tests.

const threadId = "t1" as ThreadId;
const leadId = "agt_lead" as AgentId;
const start = Date.now() - 6 * 60_000;
let sequence = 0;

const event = (payload: EventPayload): AgentEvent => {
  sequence++;
  return {
    id: `${leadId}:${sequence}` as EventId,
    threadId,
    agentId: leadId,
    sequence,
    at: start + sequence * 4_000,
    payload,
  };
};

const tool = (
  callId: string,
  toolName: string,
  input: unknown,
  output: unknown,
): ReadonlyArray<AgentEvent> => [
  event({ _tag: "ToolCallStarted", callId, toolName, input }),
  event({ _tag: "ToolCallCompleted", callId, output, isError: false }),
];

export const leadFixture = {
  provider: "claude" as const,
  model: "Opus 5.5",
  effort: "high" as const,
};

export const transcriptFixture: ReadonlyArray<AgentEvent> = [
  event({
    _tag: "TurnInput",
    items: [
      {
        _tag: "FromUser",
        text: "The login test in `auth.spec.ts` fails about one run in five on CI. Find out why and fix it. Have a couple of Muse agents check whether any open PRs already touch this.",
      },
    ],
  }),
  event({
    _tag: "ReasoningCompleted",
    messageId: "m1:0",
    text: "A one-in-five failure on CI but not locally points at timing. The login test probably reads session state before an async write settles. I should read the test and the session store, and in parallel have scouts check open PRs so I don't duplicate work.",
  }),
  event({
    _tag: "MessageCompleted",
    messageId: "m1:1",
    text: "I'll read the test and the session store while two Muse agents check the open PRs.",
  }),
  ...tool(
    "c1",
    "mcp__cerium__spawn_agent",
    { role: "pr-scout", model: "scout", prompt: "List open PRs that modify src/auth/**" },
    { status: "spawned", agentId: "agt_scout1" },
  ),
  event({
    _tag: "AgentSpawned",
    childId: "agt_scout1" as AgentId,
    role: "pr-scout",
    provider: "muse",
    model: "Muse Spark 1.3",
    access: "readOnly",
  }),
  ...tool(
    "c2",
    "mcp__cerium__spawn_agent",
    { role: "pr-reviewer", model: "scout", prompt: "Check whether PR #412 changes session handling" },
    { status: "spawned", agentId: "agt_scout2" },
  ),
  event({
    _tag: "AgentSpawned",
    childId: "agt_scout2" as AgentId,
    role: "pr-reviewer",
    provider: "muse",
    model: "Muse Spark 1.3",
    access: "readOnly",
  }),
  ...tool("c3", "Read", { file_path: "src/auth/auth.spec.ts" }, "…84 lines…"),
  ...tool("c4", "Grep", { pattern: "refreshSession", path: "src/auth" }, "src/auth/session.ts:41"),
  ...tool("c5", "Read", { file_path: "src/auth/session.ts" }, "…112 lines…"),
  event({
    _tag: "MessageCompleted",
    messageId: "m2:0",
    text: [
      "Found it. `refreshSession()` resolves before the cookie write finishes:",
      "",
      "```ts",
      "export async function refreshSession(store: SessionStore) {",
      "  const token = await issueToken();",
      "  store.set(token); // not awaited: the cookie write is still pending",
      "  return token;",
      "}",
      "```",
      "",
      "The test reads the cookie straight after login, so on a slow runner it still sees the old value. The fix is to **await the write** before resolving.",
    ].join("\n"),
  }),
  event({
    _tag: "UsageReported",
    inputTokens: 18_204,
    outputTokens: 1_390,
    cachedInputTokens: 42_118,
    costUsd: 0.142,
  }),
  event({ _tag: "TurnCompleted", stopReason: "completed" }),

  event({
    _tag: "TurnInput",
    items: [
      {
        _tag: "ChildFinishedTurn",
        agentId: "agt_scout1" as AgentId,
        role: "pr-scout",
        text: "Two open PRs touch src/auth: #412 (login form styling) and #418 (OAuth scopes). Neither changes session.ts.",
      },
      {
        _tag: "ChildFinishedTurn",
        agentId: "agt_scout2" as AgentId,
        role: "pr-reviewer",
        text: "#412 only edits LoginForm.tsx and its CSS module. No session handling changes.",
      },
    ],
  }),
  event({
    _tag: "MessageCompleted",
    messageId: "m3:0",
    text: "Neither open PR conflicts with the fix. Applying it now.",
  }),
  event({
    _tag: "ToolCallStarted",
    callId: "c6",
    toolName: "Edit",
    input: {
      file_path: "src/auth/session.ts",
      old_string: "store.set(token);",
      new_string: "await store.set(token);",
    },
  }),
  event({
    _tag: "PermissionRequested",
    requestId: "c6",
    toolName: "Edit",
    summary: "Edit src/auth/session.ts",
    input: { file_path: "src/auth/session.ts" },
  }),
  event({ _tag: "PermissionResolved", requestId: "c6", decision: "allow", scope: "once" }),
  event({ _tag: "ToolCallCompleted", callId: "c6", output: "The file has been updated.", isError: false }),
  event({ _tag: "FileChanged", path: "src/auth/session.ts", change: "modified" }),
  event({
    _tag: "MessageCompleted",
    messageId: "m3:1",
    text: "Now I'll run the auth tests 20 times to confirm the flake is gone.",
  }),
  event({
    _tag: "ToolCallStarted",
    callId: "c7",
    toolName: "Bash",
    input: { command: "bun test src/auth --rerun-each 20", description: "Run auth tests 20 times" },
  }),
  event({
    _tag: "PermissionRequested",
    requestId: "c7",
    toolName: "Bash",
    summary: "Run auth tests 20 times",
    input: { command: "bun test src/auth --rerun-each 20" },
  }),
];
