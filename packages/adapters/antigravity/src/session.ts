import {
  AcpTranslator,
  acpMcpServers,
  effortChoice,
  hasHttpMcp,
  makeAcpSession,
  makeConfigState,
  openSession,
  record,
} from "@cerium/acp";
import type { AgentSession, SessionOptions, TurnExtras } from "@cerium/harness";
import type { ReasoningEffort } from "@cerium/protocol";
import { Effect } from "effect";
import { resolve } from "node:path";

import { PROVIDER, failure } from "./manifest.ts";
import { readConfig, readSessionDetails, toModelInfos } from "./models.ts";
import { connectAntigravity } from "./probe.ts";

export const antigravityTranslator = () =>
  new AcpTranslator({
    provider: PROVIDER,
    toolInput: (call) => call["rawInput"] ?? call["args"] ?? {},
  });

export const startAntigravitySession = Effect.fn("Antigravity.startSession")(function* (
  executable: string,
  options: SessionOptions,
) {
  if (options.access === "readOnly") return yield* failure("Antigravity cannot enforce read-only access");
  if (!options.includeUserMcpServers) {
    return yield* failure("Antigravity cannot start a session with the user's MCP configuration disabled");
  }
  if (options.speed !== undefined && options.speed !== "standard") {
    return yield* failure("Antigravity does not support speed selection");
  }

  const cwd = resolve(options.cwd);
  const flags: Array<string> = [];
  // Antigravity wants stdio servers tagged, though ACP leaves the tag out.
  const mcpServers = acpMcpServers(options, { tagStdio: true });
  const httpMcp = hasHttpMcp(mcpServers);
  // Antigravity only advertises and accepts HTTP MCP in the isolated worker topology.
  if (httpMcp) flags.push("--process-per-session");
  if (options.access === "fullAccess") flags.push("--dangerously-skip-permissions");
  if (options.access === "auto") flags.push("--sandbox");
  const acp = yield* connectAntigravity(executable, cwd, flags);
  if (httpMcp && !acp.agent.httpMcp) {
    return yield* failure("This Antigravity CLI does not support injected HTTP MCP servers");
  }
  const antigravity = record(record(acp.agent.capabilities?.["_meta"])?.["antigravity"]);
  const instructions = options.appendSystemPrompt;
  if (instructions && record(antigravity?.["systemPrompt"])?.["append"] !== true) {
    return yield* failure("This Antigravity CLI cannot append Cerium's system instructions");
  }

  const result = yield* openSession(acp, options.resume === undefined ? "session/new" : "session/resume", {
    cwd,
    mcpServers,
    ...(options.resume === undefined ? {} : { sessionId: options.resume }),
    _meta: {
      antigravity: {
        eagerMcpServers: mcpServers.map(({ name }) => name),
        ...(instructions ? { systemPrompt: { append: instructions } } : {}),
      },
    },
  });
  const details = yield* readSessionDetails(result).pipe(
    Effect.mapError(() => failure("Antigravity returned invalid session information")),
  );
  const { sessionId } = details;
  const config = makeConfigState({ acp, sessionId, initial: details.configOptions, read: readConfig });
  const model = () => config.current("model")?.currentValue ?? details.models.currentModelId;
  const models = toModelInfos(details);
  const session = yield* makeAcpSession({ acp, sessionId, translator: antigravityTranslator() });

  const effort = (value: ReasoningEffort) =>
    Effect.gen(function* () {
      const offered = models.find(({ id }) => id === model())?.efforts ?? [];
      if (value === "minimal" && offered.length === 0) return;
      const choice = effortChoice(offered, value);
      if (choice === undefined)
        return yield* failure(`Antigravity does not offer ${value} effort for ${model()}`);
      yield* config.set("thought_level", choice);
    });

  yield* config.set(
    "mode",
    options.access === "acceptEdits" ? "accept-edits" : options.access === "auto" ? "auto" : "default",
  );
  yield* config.set("model", options.model);
  if (options.effort !== undefined) yield* effort(options.effort);

  const activeModel = models.find(({ id }) => id === model());
  const activeEffort = activeModel?.efforts.find(
    (value) => value === config.current("thought_level")?.currentValue,
  );
  yield* session.emit({
    _tag: "SessionStarted",
    provider: PROVIDER,
    providerSessionId: sessionId,
    model: model(),
    ...(activeEffort === undefined ? {} : { effort: activeEffort }),
  });

  return {
    events: session.events,
    send: (text: string, extras?: TurnExtras) =>
      session.send(text, extras, () => Effect.succeed({ model: model() })),
    respondToPermission: session.respondToPermission,
    interrupt: session.interrupt,
    setModel: (value) => session.whenIdle(config.set("model", value)),
    setEffort: (value) => session.whenIdle(effort(value)),
  } satisfies AgentSession;
});
