import { Orchestrator } from "@cerium/orchestrator";
import type { ThreadId } from "@cerium/protocol";
import {
  BrowserStep,
  BrowserTarget,
  type BrowserCall,
  type BrowserCommand,
  type BrowserOutcome,
} from "@cerium/rpc";
import { Context, Deferred, Effect, Layer, Option, Queue, Schema, Stream, type Cause } from "effect";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServerRequest } from "effect/http";
import { randomUUID } from "node:crypto";

import { BusRegistry } from "./registry.ts";

// The browser a thread's agents share with its user, who watches it in the Preview pane. The page
// lives in the desktop shell; the bus reaches it through the desktop window, which hosts it over its
// own connection (`HostBrowser` in @cerium/rpc). Without a window here, the tools say so. Registered
// on the server directly, as `artifact_preview` is, since a screenshot answers with an image.

/** Told to an agent whose thread has no browser to drive. */
export const BROWSER_UNAVAILABLE =
  "The browser isn't available here: it opens in Cerium's desktop app, and no desktop window of this" +
  " computer is connected (Cerium is used from a browser or a phone, or runs without its window)." +
  " Carry on without it, or ask the user to open Cerium on this computer.";

/** How long one call may take before the agent hears it didn't finish. */
const CALL_TIMEOUT = "2 minutes";

/** A window hosting the browser: where its calls go. */
type Host = Queue.Queue<BrowserCall, Cause.Done>;

interface Pending {
  readonly done: Deferred.Deferred<BrowserOutcome>;
  readonly host: Host;
}

/** The desktop windows hosting the browser, and the calls they owe answers. */
export class BrowserHost extends Context.Service<
  BrowserHost,
  {
    /** Hosts the browser while it's subscribed: each call to run arrives here. */
    readonly host: Stream.Stream<BrowserCall>;
    readonly answer: (requestId: string, outcome: BrowserOutcome) => Effect.Effect<void>;
    /** Runs `command` in `threadId`'s browser, on the window that started hosting last. */
    readonly call: (threadId: ThreadId, command: BrowserCommand) => Effect.Effect<BrowserOutcome>;
  }
>()("cerium/bus/BrowserHost") {
  static readonly layer = Layer.sync(BrowserHost, () => {
    const hosts: Array<Host> = [];
    const pending = new Map<string, Pending>();

    const settle = (requestId: string, outcome: BrowserOutcome) => {
      const call = pending.get(requestId);
      pending.delete(requestId);
      if (call !== undefined) Deferred.doneUnsafe(call.done, Effect.succeed(outcome));
    };

    return BrowserHost.of({
      host: Stream.callback<BrowserCall>((queue) =>
        Effect.gen(function* () {
          hosts.push(queue);
          // A window that goes away leaves its calls unanswered: they fail rather than wait it out.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              hosts.splice(hosts.indexOf(queue), 1);
              for (const [requestId, call] of pending) {
                if (call.host === queue) {
                  settle(requestId, {
                    _tag: "Failed",
                    message: "Cerium's window closed before it answered.",
                  });
                }
              }
            }),
          );
        }),
      ),
      answer: (requestId, outcome) => Effect.sync(() => settle(requestId, outcome)),
      call: (threadId, command) =>
        Effect.gen(function* () {
          const host = hosts.at(-1);
          if (host === undefined) return { _tag: "Failed", message: BROWSER_UNAVAILABLE } as const;
          const requestId = randomUUID();
          const done = yield* Deferred.make<BrowserOutcome>();
          pending.set(requestId, { done, host });
          Queue.offerUnsafe(host, { requestId, threadId, command });
          return yield* Deferred.await(done).pipe(
            Effect.timeoutOrElse({
              duration: CALL_TIMEOUT,
              orElse: () =>
                Effect.succeed<BrowserOutcome>({
                  _tag: "Failed",
                  message:
                    "The browser didn't finish in 2 minutes. browser_read shows where the page is now.",
                }),
            }),
            Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
          );
        }),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Tools

const target = {
  text: { type: "string", description: "Visible text or accessible name to find; the best match wins." },
  selector: { type: "string", description: "A CSS selector, for what text can't name." },
  nth: { type: "integer", description: "Which match, from 0 in page order, when several fit." },
  x: { type: "number", description: "With y: a point in the viewport, as browser_read gives them." },
  y: { type: "number" },
} as const;

const annotations = (title: string, readOnly: boolean) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: false,
  idempotentHint: readOnly,
  openWorldHint: true,
});

const OpenInput = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  go: Schema.optionalKey(Schema.Literals(["back", "forward", "reload"])),
});
const ReadInput = Schema.Struct({ text: Schema.optionalKey(Schema.Boolean) });
const ActInput = Schema.Struct({
  steps: Schema.Array(BrowserStep).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  screenshot: Schema.optionalKey(Schema.Boolean),
});
const ScreenshotInput = Schema.Struct({
  fullPage: Schema.optionalKey(Schema.Boolean),
  of: Schema.optionalKey(BrowserTarget),
});
const LogsInput = Schema.Struct({});

interface BrowserTool<I> {
  readonly tool: McpSchema.Tool;
  readonly input: Schema.Codec<I, unknown>;
  readonly usage: string;
  readonly command: (input: I) => BrowserCommand;
}

const browserTool = <I>(tool: BrowserTool<I>) => tool;

const ONE_BROWSER =
  " One browser per thread, which the user watches in Cerium's Preview pane beside the thread and" +
  " your thread's other agents share.";

export const BROWSER_TOOLS = [
  browserTool({
    tool: new McpSchema.Tool({
      name: "browser_open",
      title: "Open in browser",
      description:
        "Open a page in your thread's browser: a `url` (http or https; `localhost:5173` works), or `go`" +
        " back, forward or reload. With neither, says what it shows." +
        ONE_BROWSER +
        " Answers with the page's title and URL; browser_read shows what is on it.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The page to open." },
          go: { type: "string", enum: ["back", "forward", "reload"] },
        },
      },
      annotations: annotations("Open in browser", false),
    }),
    input: OpenInput,
    usage: "Give `url` (http or https) or `go` (back, forward or reload).",
    command: ({ url, go }) => ({
      _tag: "Open",
      ...(url === undefined ? {} : { url }),
      ...(go ? { go } : {}),
    }),
  }),
  browserTool({
    tool: new McpSchema.Tool({
      name: "browser_read",
      title: "Read the page",
      description:
        "Read the page in your thread's browser: its title and URL, and the controls and headings in view," +
        " each with its role, name, value, states and the point at its centre. `text` adds the page's" +
        " visible text. Read before acting, and again once the page changed.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "boolean", description: "Add the page's visible text (default false)." },
        },
      },
      annotations: annotations("Read the page", true),
    }),
    input: ReadInput,
    usage: "`text` is optional, true or false.",
    command: ({ text }) => ({ _tag: "Read", text: text === true }),
  }),
  browserTool({
    tool: new McpSchema.Tool({
      name: "browser_act",
      title: "Act on the page",
      description:
        "Use the page in your thread's browser as a user would, a step at a time, stopping at the first" +
        " that fails. Steps: click, doubleClick, rightClick, hover; type (`value` into the focused field," +
        " or into the target first), fill (clears it first); press (`value`: Enter, Tab, Control+A);" +
        " scroll (`value`: pixels down, negative up); drag (to `to`); wait and waitGone (until the target" +
        " shows or goes, `ms` at most); sleep (`ms`). A target is visible `text` or an accessible name, a" +
        " CSS `selector`, or `x`,`y` from browser_read, with `nth` among several matches. `screenshot` adds" +
        " one once the steps are done.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: [
                    "click",
                    "doubleClick",
                    "rightClick",
                    "hover",
                    "type",
                    "fill",
                    "press",
                    "scroll",
                    "drag",
                    "wait",
                    "waitGone",
                    "sleep",
                  ],
                },
                ...target,
                value: {
                  type: "string",
                  description: "What type and fill enter, the keys press presses, the pixels scroll moves.",
                },
                to: {
                  type: "object",
                  description: "Where drag drops: text, selector, nth, or x and y.",
                  properties: target,
                },
                ms: {
                  type: "integer",
                  description: "How long wait waits (5000 by default) or sleep pauses.",
                },
              },
              required: ["action"],
            },
          },
          screenshot: { type: "boolean", description: "Add a screenshot once the steps are done." },
        },
        required: ["steps"],
      },
      annotations: annotations("Act on the page", false),
    }),
    input: ActInput,
    usage: "Give `steps`: 1 to 30 of { action, target fields, value, to, ms }.",
    command: ({ steps, screenshot }) => ({ _tag: "Act", steps, screenshot: screenshot === true }),
  }),
  browserTool({
    tool: new McpSchema.Tool({
      name: "browser_screenshot",
      title: "Screenshot the page",
      description:
        "A screenshot of the page in your thread's browser: what the user sees in the Preview pane, the" +
        " whole page (`fullPage`), or one element (`of`).",
      inputSchema: {
        type: "object",
        properties: {
          fullPage: { type: "boolean", description: "The whole page, not just what is in view." },
          of: {
            type: "object",
            description: "One element: text, selector, nth, or x and y.",
            properties: target,
          },
        },
      },
      annotations: annotations("Screenshot the page", true),
    }),
    input: ScreenshotInput,
    usage: "`fullPage` and `of` are optional.",
    command: ({ fullPage, of }) => ({
      _tag: "Screenshot",
      fullPage: fullPage === true,
      ...(of ? { of } : {}),
    }),
  }),
  browserTool({
    tool: new McpSchema.Tool({
      name: "browser_logs",
      title: "Read the page's logs",
      description:
        "The console messages, uncaught errors and failed requests (network errors, 4xx and 5xx answers) of" +
        " the page in your thread's browser since you last asked; asking clears them.",
      inputSchema: { type: "object", properties: {} },
      annotations: annotations("Read the page's logs", true),
    }),
    input: LogsInput,
    usage: "Takes no arguments.",
    command: () => ({ _tag: "Logs" }),
  }),
] as const;

const BEARER = /^Bearer\s+(.+)$/i;

const failure = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });

/** Registers the browser tools on the bus's MCP server. Requires the BusRegistry, the Orchestrator and the BrowserHost. */
export const BrowserTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registry = yield* BusRegistry;
    const orchestrator = yield* Orchestrator;
    const browser = yield* BrowserHost;
    for (const each of BROWSER_TOOLS as ReadonlyArray<BrowserTool<any>>) {
      yield* server.addTool({
        tool: each.tool,
        annotations: Context.empty(),
        handle: (payload) =>
          Effect.gen(function* () {
            const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
            const token = Option.flatMap(request, (http) =>
              Option.fromNullishOr(BEARER.exec(http.headers["authorization"] ?? "")?.[1]),
            );
            const agentId = Option.flatMap(token, (value) => registry.agentFor(value));
            if (Option.isNone(agentId)) return failure("Unknown Cerium agent.");
            const agent = yield* orchestrator.agent(agentId.value).pipe(Effect.option);
            if (Option.isNone(agent)) return failure("Unknown Cerium agent.");
            const input = yield* Schema.decodeUnknownEffect(each.input)(payload).pipe(Effect.option);
            if (Option.isNone(input)) return failure(each.usage);
            const outcome = yield* browser.call(agent.value.threadId, each.command(input.value));
            if (outcome._tag === "Failed") return failure(outcome.message);
            return new McpSchema.CallToolResult({
              content: [
                { type: "text", text: outcome.text },
                ...(outcome.image === undefined
                  ? []
                  : [
                      {
                        type: "image" as const,
                        data: new Uint8Array(Buffer.from(outcome.image, "base64")),
                        mimeType: "image/png",
                      },
                    ]),
              ],
            });
          }),
      });
    }
  }),
);
