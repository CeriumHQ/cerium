// A scripted ACP v1 agent for @cerium/acp's tests. Its behavior follows the methods and prompt texts
// it receives; `ACP_FIXTURE_*` variables shape its `initialize` result and sign-in.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const log = (entry) =>
  env.ACP_FIXTURE_LOG && appendFileSync(env.ACP_FIXTURE_LOG, JSON.stringify(entry) + "\n");
const sid = "fixture-session";
const update = (sessionUpdate, fields = {}) =>
  send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate, ...fields } } });
const say = (text) => update("agent_message_chunk", { content: { type: "text", text } });

const config = new Map([
  ["model", { currentValue: "fixture-a", options: ["fixture-a", "fixture-b", "stubborn"] }],
  ["mode", { currentValue: "default", options: ["default", "auto"] }],
]);
const configOptions = () =>
  Array.from(config, ([id, { currentValue, options }]) => ({
    id,
    currentValue,
    options: options.map((value) => ({ value, name: value.toUpperCase() })),
  }));

/** Requests Cerium has yet to answer, by the id the fixture gave them. */
const waiting = new Map();
let nextClientId = 1;
const ask = (method, params, then) => {
  const id = `client-${nextClientId++}`;
  waiting.set(id, then);
  send({ id, method, params });
};

let prompt;
const finish = (result) => {
  if (prompt === undefined) return;
  send({ id: prompt, result });
  prompt = undefined;
};

const permission = (options, then) =>
  ask(
    "session/request_permission",
    {
      sessionId: sid,
      toolCall: {
        toolCallId: "call-1",
        title: "Run tests",
        kind: "execute",
        rawInput: { command: "npm test" },
      },
      options,
    },
    then,
  );
const once = [
  { kind: "allow_always", optionId: "always" },
  { kind: "allow_once", optionId: "once" },
  { kind: "reject_once", optionId: "reject" },
];
const outcome = (result) =>
  result.outcome.outcome === "selected" ? `selected:${result.outcome.optionId}` : result.outcome.outcome;

const turn = (id, params) => {
  prompt = id;
  const text = params.prompt[0]?.text;
  switch (text) {
    case "hello":
      update("agent_thought_chunk", { content: { type: "text", text: "Thinking" } });
      say("Hel");
      say("lo");
      update("tool_call", { toolCallId: "write", title: "Write", kind: "edit", rawInput: { path: "a.ts" } });
      update("tool_call_update", {
        toolCallId: "write",
        status: "completed",
        content: [{ type: "diff", path: "/repo/a.ts", newText: "new" }],
      });
      update("plan", { entries: [{ content: "Test", status: "in_progress" }] });
      update("usage_update", { used: 900, size: 200000 });
      return finish({
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 },
      });
    case "approve":
    case "always":
      return permission(text === "approve" ? once : [once[0]], (result) => {
        say(outcome(result));
        finish({ stopReason: "end_turn" });
      });
    case "wait":
      return permission(once, (result) => log({ permission: outcome(result) }));
    case "hang":
      return;
    case "auth":
      prompt = undefined;
      return send({ id, error: { code: -32000, message: "Authentication required" } });
    case "refuse":
      return finish({ stopReason: "refusal" });
    case "die":
      return process.exit(1);
    case "images":
      say(`${params.prompt.length - 1} images, meta ${JSON.stringify(params._meta ?? null)}`);
      return finish({ stopReason: "end_turn" });
    case "hook":
      return ask("fixture/hook", { sessionId: sid }, (result) => {
        say(JSON.stringify(result));
        finish({ stopReason: "end_turn" });
      });
    default:
      say(text);
      return finish({ stopReason: "end_turn" });
  }
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  log({ method, id, params, result: message.result, error: message.error });
  const reply = (result) => send({ id, result });
  if (method === undefined) {
    const then = waiting.get(id);
    waiting.delete(id);
    then?.(message.result ?? { error: message.error });
    continue;
  }
  switch (method) {
    case "initialize":
      // Noise an agent might print, which the client must skip.
      process.stdout.write("Starting fixture agent…\n");
      process.stdout.write(JSON.stringify({ jsonrpc: "1.0", id: 1, result: "wrong" }) + "\n");
      reply({
        protocolVersion: Number(env.ACP_FIXTURE_PROTOCOL ?? 1),
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {} },
          promptCapabilities: { image: env.ACP_FIXTURE_IMAGES !== "0" },
          mcpCapabilities: { http: true },
        },
        authMethods: [{ id: "fixture-login" }],
        _meta: { fixture: params._meta ?? null },
      });
      break;
    case "echo":
      setTimeout(() => reply({ echo: params.value }), params.delay ?? 0);
      break;
    case "fail":
      send({ id, error: { code: params.code, message: params.message } });
      break;
    case "silent":
      break;
    case "exit":
      process.exit(3);
      break;
    case "ask_client":
      ask(params.method, {}, (result) => reply(result));
      break;
    case "notify_client":
      send({ method: "fixture/note", params: { n: 1 } });
      reply({});
      break;
    case "fixture/exit":
      process.exit(0);
      break;
    case "session/new":
    case "session/resume":
      if (env.ACP_FIXTURE_LOGGED_OUT) {
        send({ id, error: { code: -32000, message: "Authentication required" } });
        break;
      }
      reply({ sessionId: sid, configOptions: configOptions() });
      break;
    case "session/set_config_option": {
      const option = config.get(params.configId);
      if (option === undefined) {
        send({ id, error: { code: -32602, message: `No option ${params.configId}` } });
        break;
      }
      if (params.value !== "stubborn") option.currentValue = params.value;
      reply({ configOptions: configOptions() });
      break;
    }
    case "session/close":
      reply({});
      break;
    case "session/prompt":
      turn(id, params);
      break;
    case "session/cancel":
      finish({ stopReason: "cancelled" });
      break;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
}
