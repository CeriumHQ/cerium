import {
  acpMcpServers,
  answerOnce,
  cancelledOutcome,
  configOption,
  effortChoice,
  hasHttpMcp,
  makeAcpSession,
  makeConfigState,
  onceOptions,
  openSession,
  readConfigOptions,
  record,
  refusal,
  selectedOutcome,
  string,
  type RequestHandler,
} from "@cerium/acp";
import type { AgentSession, SessionOptions, TurnExtras } from "@cerium/harness";
import type { AccessMode, ModelSpeed, ReasoningEffort } from "@cerium/protocol";
import { Effect } from "effect";
import { resolve } from "node:path";

import { writeSessionConfig } from "./config.ts";
import { PROVIDER, failure } from "./manifest.ts";
import { acceptsImages, variantOf } from "./models.ts";
import { connectDevin } from "./probe.ts";
import { DevinTranslator } from "./translate.ts";

/**
 * Devin's session modes for Cerium's access. Ask mode withholds its write and shell tools. Code mode
 * accepts workspace edits, which the session's config sends to approval for Cerium's Ask.
 */
const MODES: Record<AccessMode, string> = {
  readOnly: "ask",
  ask: "accept-edits",
  acceptEdits: "accept-edits",
  auto: "smart",
  fullAccess: "bypass",
};

/** The server of an MCP tool as Devin names it (`mcp__server__tool`). */
const mcpServer = (tool: string) => (tool.startsWith("mcp__") ? tool.slice(5).split("__", 1)[0] : undefined);

/** Devin has no appendable system prompt over ACP, so Cerium's instructions open the first turn. */
export const withInstructions = (instructions: string, text: string) =>
  [
    "<cerium_instructions>",
    "Cerium, the app running this session, adds these instructions. Follow them like system instructions.",
    "",
    instructions,
    "</cerium_instructions>",
    "",
    text,
  ].join("\n");

export const startDevinSession = Effect.fn("Devin.startSession")(function* (
  executable: string,
  options: SessionOptions,
  userConfig?: string,
) {
  const cwd = resolve(options.cwd);
  const readOnly = options.access === "readOnly";
  const trusted = new Set(options.trustedMcpServers);
  // Read-only sessions get only the servers whose tools run without asking, as approval can't be given.
  const mcpServers = acpMcpServers(options);
  const injected = new Set(mcpServers.map(({ name }) => name));
  const configFile = yield* writeSessionConfig(
    options.access,
    options.includeUserMcpServers && !readOnly,
    userConfig,
  );
  const acp = yield* connectDevin(executable, cwd, configFile);
  if (hasHttpMcp(mcpServers) && !acp.agent.httpMcp) {
    return yield* failure("This Devin CLI does not support injected HTTP MCP servers");
  }
  if (options.resume !== undefined && !acp.agent.loadSession) {
    return yield* failure("This Devin CLI cannot resume sessions over ACP");
  }

  // Loading a session replays its history as updates; nothing is active yet, so they are dropped.
  const result = yield* openSession(acp, options.resume === undefined ? "session/new" : "session/load", {
    cwd,
    mcpServers,
    ...(options.resume === undefined ? {} : { sessionId: options.resume }),
  });
  const sessionId = options.resume ?? string(record(result)?.["sessionId"]);
  if (sessionId === undefined) return yield* failure("Devin did not open a session");
  const config = makeConfigState({
    acp,
    sessionId,
    initial: readConfigOptions(record(result)?.["configOptions"]),
  });
  const model = () => config.current("model")?.currentValue ?? options.model;
  let instructions = options.resume === undefined ? options.appendSystemPrompt : undefined;
  const translator = new DevinTranslator();

  const permission: RequestHandler = (id, params, session) => {
    if (!session.accepting(params)) return acp.respond(id, cancelledOutcome);
    const tool = record(params["toolCall"]);
    const once = onceOptions(params);
    if (tool === undefined || once.allow === undefined) return acp.respond(id, refusal(once));
    // The request names the rule it would grant, such as `Exec(npm)` or `mcp__cerium__spawn`.
    const meta = record(tool["_meta"]);
    const rule = string(meta?.["cognition.ai/permissionRule"]);
    const callId = string(tool["toolCallId"]);
    const call = callId === undefined ? undefined : translator.call(callId);
    const name = call?.toolName ?? rule ?? "Tool";
    const server = mcpServer(rule ?? name);
    if (server !== undefined && trusted.has(server) && injected.has(server)) {
      return acp.respond(id, selectedOutcome(once.allow));
    }
    const userServer = server !== undefined && !injected.has(server);
    if (readOnly || (userServer && !options.includeUserMcpServers)) return acp.respond(id, refusal(once));
    return session.ask({
      id,
      toolName: name,
      summary: string(meta?.["cognition.ai/editableCommand"]) ?? call?.title ?? rule ?? name,
      input: call?.input ?? {},
      answer: answerOnce(once),
    });
  };
  const session = yield* makeAcpSession({ acp, sessionId, translator, permission });

  const effort = (value: ReasoningEffort) =>
    Effect.gen(function* () {
      const { efforts } = variantOf(config.options());
      if (efforts.length === 0) return;
      const choice = effortChoice(efforts, value);
      if (choice === undefined) return yield* failure(`Devin does not offer ${value} effort for ${model()}`);
      yield* config.set("thought_level", choice);
    });

  const speed = (value: ModelSpeed) =>
    variantOf(config.options()).speeds === undefined && value === "standard"
      ? Effect.void
      : config.set("speed", value);

  yield* config.set("mode", MODES[options.access]);
  yield* config.set("model", options.model);
  if (options.effort !== undefined) yield* effort(options.effort);
  if (options.speed !== undefined) yield* speed(options.speed);

  const started = variantOf(config.options());
  yield* session.emit({
    _tag: "SessionStarted",
    provider: PROVIDER,
    providerSessionId: sessionId,
    model: model(),
    ...(started.defaultEffort === undefined ? {} : { effort: started.defaultEffort }),
  });

  return {
    events: session.events,
    send: (text: string, extras?: TurnExtras) =>
      session.send(text, extras, () =>
        Effect.gen(function* () {
          if (extras?.images?.length) {
            const choice = configOption(config.options(), "model")?.options.find(
              ({ value }) => value === model(),
            );
            if (acceptsImages(choice) === false) {
              return yield* failure(`Devin's ${model()} does not accept images`);
            }
          }
          const opening = instructions;
          instructions = undefined;
          return {
            model: model(),
            ...(opening === undefined ? {} : { text: withInstructions(opening, text) }),
          };
        }),
      ),
    respondToPermission: session.respondToPermission,
    interrupt: session.interrupt,
    setModel: (value) => session.whenIdle(config.set("model", value)),
    setEffort: (value) => session.whenIdle(effort(value)),
    setSpeed: (value) => session.whenIdle(speed(value)),
  } satisfies AgentSession;
});
