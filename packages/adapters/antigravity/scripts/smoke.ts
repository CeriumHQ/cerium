// Real, subscription-backed check. Install the official standalone ACP runtime and sign in through
// Cerium first. Optional --login starts the harness's own OAuth flow (credentials stay native).
// CERIUM_ANTIGRAVITY_PATH=/absolute/path/agy_acp_server.exe node .../scripts/smoke.ts [model-id]
import type { AgentSession, SessionOptions } from "@cerium/harness";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Data, Effect, Layer, Stream } from "effect";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityAdapter } from "../src/index.ts";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "cerium-agy-smoke-")));
writeFileSync(join(workspace, "hello.txt"), "PELICAN-42\n");
const echo = join(import.meta.dirname, "../../cursor/scripts/echo-mcp.ts");
let sessionId = "";
class SmokeFailure extends Data.TaggedError("SmokeFailure")<{ readonly message: string }> {}

const turn = (session: AgentSession, prompt: string, decision: "allow" | "deny") =>
  Effect.gen(function* () {
    let permissions = 0;
    let mcpCompleted = 0;
    let mcpPermissions = 0;
    const mcpCalls = new Set<string>();
    let reply = "";
    let problem: string | undefined;
    yield* session.send(prompt);
    yield* session.events.pipe(
      Stream.takeUntil(({ payload }) => payload._tag === "TurnCompleted"),
      Stream.runForEach(({ payload }) =>
        Effect.gen(function* () {
          if (payload._tag === "SessionStarted") sessionId = payload.providerSessionId;
          if (payload._tag === "PermissionRequested") {
            permissions++;
            if (payload.toolName.startsWith("mcp__smoke__")) mcpPermissions++;
            yield* session.respondToPermission(payload.requestId, { decision, scope: "once" });
          }
          if (payload._tag === "MessageCompleted") reply = payload.text;
          if (payload._tag === "ToolCallStarted" && payload.toolName.startsWith("mcp__smoke__"))
            mcpCalls.add(payload.callId);
          if (payload._tag === "ToolCallCompleted" && mcpCalls.has(payload.callId) && !payload.isError)
            mcpCompleted++;
          if (payload._tag === "AgentError" || payload._tag === "AuthRequired")
            problem = JSON.stringify(payload);
          if (payload._tag !== "MessageDelta" && payload._tag !== "ReasoningDelta")
            yield* Console.log(JSON.stringify(payload));
        }),
      ),
    );
    if (problem) return yield* Effect.fail(new SmokeFailure({ message: problem }));
    return { permissions, reply, mcpCompleted, mcpPermissions };
  }).pipe(Effect.timeout("90 seconds"));

const program = Effect.gen(function* () {
  const adapter = yield* AntigravityAdapter;
  if (process.argv.includes("--login"))
    yield* adapter.login!.pipe(Stream.runForEach((event) => Console.log(event)));
  const status = yield* adapter.probe;
  yield* Console.log("probe:", JSON.stringify(status));
  if (status._tag !== "HarnessInstalled" || status.auth._tag !== "LoggedIn") {
    yield* Console.log(
      "LIVE PROMPTS NOT RUN: install/sign in to the official Antigravity ACP runtime first.",
    );
    return;
  }
  const models = yield* adapter.listModels;
  yield* Console.log("models:", JSON.stringify(models));
  const chosen =
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    models.find((model) => model.isDefault)?.id ??
    models[0]?.id;
  if (!chosen) return yield* Effect.fail(new SmokeFailure({ message: "No models offered" }));
  const options: SessionOptions = {
    cwd: workspace,
    model: chosen,
    access: "ask",
    includeUserMcpServers: false,
    mcpServers: { smoke: { type: "stdio", command: process.execPath, args: [echo] } },
    trustedMcpServers: ["smoke"],
  };
  yield* Effect.gen(function* () {
    const session = yield* adapter.startSession(options);
    const first = yield* turn(
      session,
      "Read hello.txt. Use the injected smoke MCP echo tool with CERIUM-MCP. Write its original contents plus APPROVED to approved.txt, using your file editing tool. Remember the code in hello.txt. Be brief.",
      "allow",
    );
    if (!existsSync(join(workspace, "approved.txt")) || first.permissions === 0) {
      return yield* Effect.fail(
        new SmokeFailure({ message: "The approved write did not happen through a permission request" }),
      );
    }
    if (first.mcpCompleted === 0 || first.mcpPermissions !== 0) {
      return yield* Effect.fail(
        new SmokeFailure({
          message: "Trusted MCP injection failed, was not recognized, or requested approval",
        }),
      );
    }
    const rejected = yield* turn(
      session,
      "Write DENIED to denied.txt using your file editing tool. Stop if refused.",
      "deny",
    );
    if (existsSync(join(workspace, "denied.txt")) || rejected.permissions === 0) {
      return yield* Effect.fail(
        new SmokeFailure({ message: "The denied write bypassed Cerium or never requested approval" }),
      );
    }
    const other = models.find((model) => model.id !== chosen);
    if (other) {
      yield* session.setModel(other.id);
      if (other.efforts[0]) yield* session.setEffort(other.efforts[0]);
    }
  }).pipe(Effect.scoped);
  yield* Effect.gen(function* () {
    const resumed = yield* adapter.startSession({ ...options, resume: sessionId, access: "readOnly" });
    const answer = yield* turn(
      resumed,
      "What code did hello.txt contain in our first turn? Then try to create readonly.txt with a file editing tool. Stop if blocked.",
      "allow",
    );
    if (!answer.reply.includes("PELICAN-42") || existsSync(join(workspace, "readonly.txt"))) {
      return yield* Effect.fail(
        new SmokeFailure({ message: "Resume memory or read-only enforcement failed" }),
      );
    }
  }).pipe(Effect.scoped);
  const listed = yield* adapter.listSessions!;
  const own = listed.find((session) => session.id === sessionId);
  if (!own) return yield* Effect.fail(new SmokeFailure({ message: "The smoke session was not listed" }));
  const history = yield* adapter.readSession!(own);
  if (history.turns.length === 0)
    return yield* Effect.fail(new SmokeFailure({ message: "No history was imported" }));
  yield* Console.log(
    "PASS: approvals, denial, read-only, model/effort switches, resume and import.",
    "Trusted MCP injection completed without an approval request.",
    "Native session kept for inspection:",
    sessionId,
    "workspace:",
    workspace,
    "approved:",
    readFileSync(join(workspace, "approved.txt"), "utf8"),
  );
}).pipe(
  Effect.timeout("5 minutes"),
  Effect.scoped,
  Effect.provide(AntigravityAdapter.layer.pipe(Layer.provideMerge(NodeServices.layer))),
);

NodeRuntime.runMain(program);
