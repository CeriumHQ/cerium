import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";

// A realistic lead transcript for building the transcript's components (the playground, src/dev):
// an Opus lead investigates a flaky test with two Muse scouts, fixes it, explains it in a reply that
// uses most of what markdown can do, and waits for approval to run the tests again.

const threadId = "t1" as ThreadId;
const leadId = "agt_lead" as AgentId;
let clock = Date.now() - 6 * 60_000;
let sequence = 0;

/** An event `after` milliseconds after the one before it. */
const event = (payload: EventPayload, after = 1_200): AgentEvent => {
  sequence++;
  clock += after;
  return { id: `${leadId}:${sequence}` as EventId, threadId, agentId: leadId, sequence, at: clock, payload };
};

/** A call that `took` milliseconds. */
const tool = (
  callId: string,
  toolName: string,
  input: unknown,
  output: unknown,
  { isError = false, took = 400 }: { isError?: boolean; took?: number } = {},
): ReadonlyArray<AgentEvent> => [
  event({ _tag: "ToolCallStarted", callId, toolName, input }),
  event({ _tag: "ToolCallCompleted", callId, output, isError }, took),
];

export const leadFixture = {
  provider: "claude" as const,
  model: "Opus 5.5",
  effort: "high" as const,
};

const sessionTs = [
  "import { issueToken } from './tokens';",
  "",
  "export interface SessionStore {",
  "  get(): string | undefined;",
  "  set(token: string): Promise<void>;",
  "}",
  "",
  "export async function refreshSession(store: SessionStore) {",
  "  const token = await issueToken();",
  "  store.set(token);",
  "  return token;",
  "}",
].join("\n");

const testRun = [
  "bun test v1.3.2",
  "",
  "src/auth/auth.spec.ts:",
  "✓ login > stores the session cookie [12.40ms]",
  "✗ login > reads the refreshed session [31.02ms]",
  "  expect(received).toBe(expected)",
  '  Expected: "tok_b81"',
  '  Received: "tok_a07"',
  "      at <anonymous> (src/auth/auth.spec.ts:38:27)",
  "✓ logout > clears the cookie [3.11ms]",
  "",
  " 2 pass",
  " 1 fail",
  " 6 expect() calls",
  "Ran 3 tests across 1 file. [148.00ms]",
].join("\n");

/** The reply that explains the fix, using most of what agents write in markdown. */
export const explanation = [
  "## What was going on",
  "",
  "The flake came from a **race between the cookie write and the test's read**. `refreshSession()` returned as soon as it had a token, while `store.set()` was still writing it, so on a slow CI runner the test sometimes read the *previous* session. See [the Bun test docs](https://bun.sh/docs/cli/test) for `--rerun-each`, which is how I reproduced it.",
  "",
  "### The fix",
  "",
  "1. Await the write in `src/auth/session.ts` before resolving.",
  "2. Make `SessionStore.set` return its promise everywhere:",
  "   - the cookie store already did",
  "   - the in-memory store used in tests now does too",
  "3. Drop the `sleep(50)` the test used to paper over it.",
  "",
  "```ts",
  "export async function refreshSession(store: SessionStore) {",
  "  const token = await issueToken();",
  "  await store.set(token); // the read after login now sees this token",
  "  return token;",
  "}",
  "```",
  "",
  "> [!NOTE]",
  "> Nothing else awaited `refreshSession()` for its side effect, so the change is safe for the other callers.",
  "",
  "| Run | Before | After |",
  "| --- | ---: | ---: |",
  "| Local, 20 reruns | 0 failures | 0 failures |",
  "| CI runner, 20 reruns | 4 failures | 0 failures |",
  "| Mean test time | 148 ms | 151 ms |",
  "",
  "Left to do:",
  "",
  "- [x] Fix the race",
  "- [x] Remove the sleep",
  "- [ ] Re-run the suite on CI",
  "",
  "To try it yourself:",
  "",
  "```bash",
  "bun test src/auth --rerun-each 20",
  "```",
  "",
  "---",
  "",
  "The ~3 ms slower mean is the awaited write; it's well inside the noise.",
].join("\n");

export const transcriptFixture: ReadonlyArray<AgentEvent> = [
  event({ _tag: "SessionStarted", provider: "claude", providerSessionId: "s1", model: "Opus 5.5" }),
  event({
    _tag: "TurnInput",
    items: [
      {
        _tag: "FromUser",
        text: "The login test in `auth.spec.ts` fails about one run in five on CI. Find out why and fix it.\nHave a couple of Muse agents check whether any open PRs already touch this.",
      },
    ],
  }),
  event(
    {
      _tag: "ReasoningCompleted",
      messageId: "m1:0",
      text: "A one-in-five failure on CI but not locally points at **timing**. The login test probably reads session state before an async write settles.\n\nI should read the test and the session store, and in parallel have scouts check open PRs so I don't duplicate work.",
    },
    6_400,
  ),
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
  ...tool(
    "c3",
    "Read",
    { file_path: "src/auth/auth.spec.ts" },
    "     1\timport { login } from './login';\n     2\t…84 lines…",
  ),
  ...tool(
    "c4",
    "Grep",
    { pattern: "refreshSession", path: "src/auth" },
    "src/auth/session.ts:8\nsrc/auth/login.ts:21\nsrc/auth/auth.spec.ts:30",
  ),
  ...tool("c5", "Read", { file_path: "src/auth/session.ts" }, sessionTs),
  ...tool(
    "c5b",
    "Bash",
    { command: "bun test src/auth --rerun-each 20", description: "Reproduce the flake with 20 reruns" },
    `Exit code 1\n${testRun}`,
    { isError: true, took: 14_200 },
  ),
  ...tool(
    "c5c",
    "WebFetch",
    { url: "https://bun.sh/docs/cli/test", prompt: "How does --rerun-each work?" },
    "`--rerun-each <n>` runs every test file n times, which surfaces flaky tests.",
    { took: 2_600 },
  ),
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
    turnId: "turn2",
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
        text: "#412 only edits `LoginForm.tsx` and its CSS module.\n\n- No session handling changes\n- No test changes",
      },
    ],
  }),
  event({
    _tag: "MessageCompleted",
    messageId: "m3:0",
    text: "Neither open PR conflicts with the fix. Applying it now.",
  }),
  ...tool(
    "c6",
    "Edit",
    {
      file_path: "src/auth/session.ts",
      old_string: "  const token = await issueToken();\n  store.set(token);\n  return token;",
      new_string: "  const token = await issueToken();\n  await store.set(token);\n  return token;",
    },
    "The file has been updated.",
  ),
  event({ _tag: "FileChanged", path: "src/auth/session.ts", change: "modified" }),
  ...tool(
    "c7",
    "Edit",
    {
      file_path: "src/auth/auth.spec.ts",
      old_string: "    await login(user);\n    await sleep(50);\n    expect(cookie()).toBe(token);",
      new_string: "    await login(user);\n    expect(cookie()).toBe(token);",
    },
    "The file has been updated.",
  ),
  event({ _tag: "FileChanged", path: "src/auth/auth.spec.ts", change: "modified" }),
  ...tool(
    "c8",
    "Bash",
    { command: "bun test src/auth --rerun-each 20", description: "Run auth tests 20 times" },
    " 60 pass\n 0 fail\n 120 expect() calls\nRan 60 tests across 1 file. [2.91s]",
    { took: 9_800 },
  ),
  event(
    {
      _tag: "ReasoningCompleted",
      messageId: "m3:r",
      text: "All 20 reruns pass. Before pushing I'll confirm the open PRs haven't moved since the scouts looked.",
    },
    3_200,
  ),
  ...tool(
    "c9",
    "mcp__github__list_pull_requests",
    { owner: "acme", repo: "web", state: "open" },
    '[{"number":412,"title":"Restyle the login form"},{"number":418,"title":"Narrow OAuth scopes"}]',
  ),
  ...tool(
    "c10",
    "Bash",
    { command: "git push origin HEAD" },
    "fatal: no upstream configured for branch 'fix/session-race'",
    { isError: true, took: 1_600 },
  ),
  event({ _tag: "MessageCompleted", messageId: "m3:1", text: explanation }, 21_000),
  event({
    _tag: "TurnFilesChanged",
    turnId: "turn2",
    before: "snap1",
    after: "snap2",
    files: [
      { path: "src/auth/session.ts", change: "modified", added: 1, removed: 1, via: "edit" },
      { path: "src/auth/auth.spec.ts", change: "modified", added: 0, removed: 1, via: "edit" },
    ],
  }),
  event({ _tag: "UsageReported", inputTokens: 9_870, outputTokens: 2_204, costUsd: 0.091 }),
  event({ _tag: "TurnCompleted", stopReason: "completed" }),

  event({
    _tag: "ContextCompacted",
    trigger: "auto",
    tokensBefore: 182_000,
    tokensAfter: 21_400,
    summary:
      "The user asked to fix a flaky login test. The cause was an un-awaited cookie write in `refreshSession()`; it is fixed and passes 20 reruns locally.",
  }),
  event({ _tag: "ModelChanged", model: "Opus 5.5", effort: "medium" }),
  event({
    _tag: "TurnInput",
    turnId: "turn3",
    items: [{ _tag: "FromUser", text: "Push it and run the suite on CI." }],
  }),
  event({
    _tag: "MessageCompleted",
    messageId: "m4:0",
    text: "I'll set the upstream and push, then start the CI run.",
  }),
  event({
    _tag: "ToolCallStarted",
    callId: "c11",
    toolName: "Bash",
    input: { command: "git push -u origin fix/session-race", description: "Push the branch" },
  }),
  event({
    _tag: "PermissionRequested",
    requestId: "c11",
    toolName: "Bash",
    summary: "Push the branch",
    input: { command: "git push -u origin fix/session-race" },
  }),
];
