import { Computer, GUIDE_TOPICS, MAX_STEPS, stepsSummary, type Answer, type Caller } from "@cerium/computer";
import { Orchestrator, UserSettings } from "@cerium/orchestrator";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServerRequest } from "effect/http";

import { BusRegistry } from "./registry.ts";

// Computer use for every harness: the `computer_*` tools drive the user's own desktop through
// agent-desktop (`@cerium/computer`). Nothing runs until the user turns computer use on in Settings.
// Looking needs nothing more; acting asks like a command does (`requestApproval`), by the agent's
// access; real mouse and keyboard input needs the user's second switch. Registered on the server
// directly, as the browser tools are, since a screenshot answers with an image.

const OFF =
  "Computer use is off. The user turns it on in Cerium's Settings → Computer use; ask them if the task needs it.";

const NO_PHYSICAL =
  "The user hasn't allowed real mouse and keyboard input. Do it through accessibility actions (physical false)," +
  " or ask them to turn on Mouse and keyboard in Settings → Computer use.";

const Args = Schema.Record(Schema.String, Schema.Unknown);
const Step = Schema.Struct({ command: Schema.NonEmptyString, args: Schema.optionalKey(Args) });

const GuideInput = Schema.Struct({ topic: Schema.optionalKey(Schema.Literals(GUIDE_TOPICS)) });
const ReadInput = Step;
const ActInput = Schema.Struct({
  description: Schema.NonEmptyString,
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_STEPS)),
  physical: Schema.optionalKey(Schema.Boolean),
});

const stepProperties = {
  command: { type: "string", description: "An agent-desktop command, such as snapshot or click." },
  args: {
    type: "object",
    description:
      "Its flags in snake_case without dashes, and its positional argument by name (ref_id, text, combo, app).",
  },
} as const;

const annotations = (title: string, readOnly: boolean) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: !readOnly,
  idempotentHint: readOnly,
  openWorldHint: true,
});

const guideTool = new McpSchema.Tool({
  name: "computer_guide",
  title: "Computer use guide",
  description:
    "How to see and operate the user's desktop apps with computer_read and computer_act. Read it before" +
    " first using them; `topic` opens one of its references.",
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", enum: [...GUIDE_TOPICS] } },
  },
  annotations: annotations("Computer use guide", true),
});

const readTool = new McpSchema.Tool({
  name: "computer_read",
  title: "Look at the computer",
  description:
    "Look at the user's desktop with one agent-desktop step that only reads: snapshot (an app's" +
    " accessibility tree, with refs to act on), find, get, is, screenshot (an image), list-apps," +
    " list-windows, clipboard-get, wait. computer_guide explains the steps.",
  inputSchema: { type: "object", properties: stepProperties, required: ["command"] },
  annotations: annotations("Look at the computer", true),
});

const actTool = new McpSchema.Tool({
  name: "computer_act",
  title: "Use the computer",
  description:
    "Operate the user's desktop apps: agent-desktop steps such as click, type, set-value, press, scroll," +
    ` launch or focus-window, in order, stopping at the first that fails (at most ${MAX_STEPS}). Acts on` +
    " refs from computer_read's snapshot. computer_guide explains the steps.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "What these steps do, in a few plain words; the user sees it and may be asked to approve it.",
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: MAX_STEPS,
        items: { type: "object", properties: stepProperties, required: ["command"] },
      },
      physical: {
        type: "boolean",
        description:
          "Use the real pointer and keyboard (agent-desktop's --headed), only for steps that need it. Default false.",
      },
    },
    required: ["description", "steps"],
  },
  annotations: annotations("Use the computer", false),
});

const BEARER = /^Bearer\s+(.+)$/i;

const failure = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });

const answered = (answer: Answer, hint?: string) =>
  new McpSchema.CallToolResult({
    // A step that failed makes the call one, so the harness and the thread show it as failed.
    ...(answer.ok ? {} : { isError: true }),
    content: [
      { type: "text", text: hint === undefined ? answer.text : `${answer.text}\n\n${hint}` },
      ...(answer.image === undefined
        ? []
        : [
            {
              type: "image" as const,
              data: new Uint8Array(Buffer.from(answer.image, "base64")),
              mimeType: "image/png",
            },
          ]),
    ],
  });

/** Registers the computer tools on the bus's MCP server. Requires the BusRegistry, the Orchestrator, UserSettings and the Computer. */
export const ComputerTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registry = yield* BusRegistry;
    const orchestrator = yield* Orchestrator;
    const settings = yield* UserSettings;
    const computer = yield* Computer;

    /** The calling agent, as the computer knows it; nothing when the call isn't from a Cerium agent. */
    const callerOf = Effect.gen(function* () {
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
      const token = Option.flatMap(request, (http) =>
        Option.fromNullishOr(BEARER.exec(http.headers["authorization"] ?? "")?.[1]),
      );
      const agentId = Option.flatMap(token, (value) => registry.agentFor(value));
      if (Option.isNone(agentId)) return Option.none<Caller>();
      const agent = yield* orchestrator.agent(agentId.value).pipe(Effect.option);
      return Option.map(agent, (info): Caller => ({
        threadId: info.threadId,
        agentId: info.id,
        label: `${info.model} · ${info.role}`,
      }));
    });

    const tool = <I>(
      definition: McpSchema.Tool,
      input: Schema.Codec<I, unknown>,
      usage: string,
      handle: (caller: Caller, input: I) => Effect.Effect<McpSchema.CallToolResult>,
    ) =>
      server.addTool({
        tool: definition,
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.gen(function* () {
            const caller = yield* callerOf;
            if (Option.isNone(caller)) return failure("Unknown Cerium agent.");
            if (!(yield* settings.get).computerUse.enabled) return failure(OFF);
            const decoded = yield* Schema.decodeUnknownEffect(input)(payload).pipe(Effect.option);
            if (Option.isNone(decoded)) return failure(usage);
            return yield* handle(caller.value, decoded.value);
          }),
      });

    yield* tool(
      guideTool,
      GuideInput,
      "`topic` is optional: " + GUIDE_TOPICS.join(", ") + ".",
      (_, { topic }) =>
        computer.guide(topic).pipe(
          Effect.map((text) => new McpSchema.CallToolResult({ content: [{ type: "text", text }] })),
          Effect.catch((error) => Effect.succeed(failure(error.message))),
        ),
    );

    yield* tool(
      readTool,
      ReadInput,
      "Give `command` and optional `args`, as computer_guide explains.",
      (caller, step) =>
        computer.read(caller, step).pipe(
          Effect.map((answer) => answered(answer)),
          Effect.catch((error) => Effect.succeed(failure(error.message))),
        ),
    );

    yield* tool(
      actTool,
      ActInput,
      `Give \`description\` and 1 to ${MAX_STEPS} \`steps\` of { command, args }.`,
      (caller, { description, steps, physical = false }) =>
        Effect.gen(function* () {
          const allowed = (yield* settings.get).computerUse;
          if (physical && !allowed.physicalInput) return failure(NO_PHYSICAL);
          const decision = yield* orchestrator
            .requestApproval(caller.agentId, {
              toolName: "computer_act",
              summary: `${physical ? "Use your mouse and keyboard" : "Use your computer"}: ${description}`,
              input: { description, steps: stepsSummary(steps), physical },
            })
            .pipe(Effect.orElseSucceed(() => ({ decision: "deny" as const, message: undefined })));
          if (decision.decision === "deny") return failure(decision.message ?? "The user didn't allow this.");
          const answer = yield* computer.act(caller, steps, { physical });
          // agent-desktop refuses a step that needs real input without it; say what decides that here.
          const hint =
            !physical && answer.codes.includes("POLICY_DENIED")
              ? allowed.physicalInput
                ? "A step needs real input: if the task needs it, run that step again with physical true."
                : NO_PHYSICAL
              : undefined;
          return answered(answer, hint);
        }).pipe(Effect.catch((error) => Effect.succeed(failure(error.message)))),
    );
  }),
);
