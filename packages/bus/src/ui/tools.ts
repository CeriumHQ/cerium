import { Orchestrator } from "@cerium/orchestrator";
import type { AgentId } from "@cerium/protocol";
import { Effect, Layer, Schema, Stream } from "effect";

import { failure, registerRawTool, type RawReply } from "../raw.ts";
import { BusRegistry } from "../registry.ts";
import { UiDriver } from "./driver.ts";
import { parseKeys, type Page, type Target } from "./page.ts";

// The `ui_*` bus tools: drive a web UI like a user and see it, one call per batch of steps
// (architecture §3.2). Every call that changes the page can answer with a screenshot.

const Int = (min: number, max: number) => Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max }));

const targetFields = {
  text: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description:
      "Visible text or accessible name (aria-label, title, placeholder, alt). Exact matches win over partial ones.",
  }),
  selector: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "A CSS selector, instead of text.",
  }),
  nth: Schema.optionalKey(Int(0, 500)).annotate({
    description: "Which match in page order, from 0, when several fit.",
  }),
  x: Schema.optionalKey(Schema.Finite).annotate({
    description: "A point in CSS pixels, with y, instead of text.",
  }),
  y: Schema.optionalKey(Schema.Finite),
};

const Step = Schema.Struct({
  action: Schema.Literals([
    "click",
    "rightClick",
    "doubleClick",
    "hover",
    "type",
    "press",
    "scroll",
    "drag",
    "wait",
    "waitGone",
    "sleep",
    "navigate",
    "reload",
    "back",
    "eval",
    "viewport",
    "upload",
  ]).annotate({
    description:
      "click/rightClick/doubleClick/hover a target; type `input` (into the target if one is named, else the focused" +
      " element); press `keys`; scroll by deltaY/deltaX (at the target, else the middle); drag the target onto `to`;" +
      " wait until the target shows, waitGone until it no longer does (`ms` timeout, default 5000); sleep `ms`;" +
      " navigate to `url`; reload; back; eval a `script`; viewport resizes; upload `files` into the file input at `selector`.",
  }),
  ...targetFields,
  to: Schema.optionalKey(Schema.Struct(targetFields)).annotate({ description: "drag: where to drop." }),
  input: Schema.optionalKey(Schema.String).annotate({ description: "type: the text to type." }),
  clear: Schema.optionalKey(Schema.Boolean).annotate({ description: "type: replace what the field holds." }),
  keys: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "press: a key or combination, e.g. Enter, Escape, Shift+Tab, Control+K, ArrowDown.",
  }),
  deltaX: Schema.optionalKey(Schema.Finite),
  deltaY: Schema.optionalKey(Schema.Finite).annotate({
    description: "scroll: pixels down (negative scrolls up); default 400.",
  }),
  url: Schema.optionalKey(Schema.NonEmptyString),
  script: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description:
      "eval: a JavaScript expression run in the page; promises are awaited and the JSON value returned.",
  }),
  ms: Schema.optionalKey(Int(0, 60_000)),
  width: Schema.optionalKey(Int(200, 4000)),
  height: Schema.optionalKey(Int(200, 4000)),
  scale: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 4 }))),
  mobile: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)).annotate({
    description: "upload: absolute paths.",
  }),
});
type Step = typeof Step.Type;

const viewportFields = {
  width: Schema.optionalKey(Int(200, 4000)).annotate({
    description: "Viewport width in CSS pixels; default 1280.",
  }),
  height: Schema.optionalKey(Int(200, 4000)).annotate({ description: "Viewport height; default 800." }),
  scale: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 4 }))).annotate({
    description: "Device pixel ratio, e.g. 3 for a phone; default 1.",
  }),
  mobile: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Emulate a phone: touch, mobile viewport.",
  }),
};

const OpenInput = Schema.Struct({
  url: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "The page to open, e.g. http://localhost:5173.",
  }),
  attach: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description:
      "Instead of starting a browser, attach to an app already listening for a debugger: a port such as 9222 or" +
      " http://127.0.0.1:9222 (an Electron app or browser started with --remote-debugging-port).",
  }),
  match: Schema.optionalKey(Schema.NonEmptyString).annotate({
    description: "attach: the page whose URL contains this.",
  }),
  ...viewportFields,
  colorScheme: Schema.optionalKey(Schema.Literals(["light", "dark"])),
  visible: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Show the browser window; default headless.",
  }),
  browser: Schema.optionalKey(Schema.Literals(["edge", "chrome"])),
  screenshot: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Answer with a screenshot; default true.",
  }),
});

const shotFields = {
  fullPage: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Capture the whole scrollable page.",
  }),
  crop: Schema.optionalKey(Schema.Struct(targetFields)).annotate({
    description: "Capture only this element (with a little margin), found like a step's target.",
  }),
};

const ActInput = Schema.Struct({
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(50)).annotate({
    description: "Run in order; the first failing step stops the rest.",
  }),
  screenshot: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Answer with a screenshot after the steps (or the failing one); default true.",
  }),
  ...shotFields,
});

const ScreenshotInput = Schema.Struct(shotFields);

const InspectInput = Schema.Struct({
  text: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Also return the page's visible text (up to 6000 characters).",
  }),
});

const target = (fields: {
  readonly text?: string | undefined;
  readonly selector?: string | undefined;
  readonly nth?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}): Target | undefined =>
  fields.text === undefined && fields.selector === undefined && fields.x === undefined ? undefined : fields;

const required = (step: Step, field: keyof Step) => {
  const value = step[field];
  if (value === undefined) throw new Error(`${step.action} needs \`${field}\`.`);
  return value;
};

/** Runs one step; returns what the agent should hear about it. */
const runStep = async (page: Page, step: Step): Promise<Record<string, unknown>> => {
  const at = target(step);
  const need = () => {
    if (at === undefined) throw new Error(`${step.action} needs a target: text, selector, or x and y.`);
    return at;
  };
  switch (step.action) {
    case "click":
    case "rightClick":
    case "doubleClick": {
      const found = await page.click(need(), {
        button: step.action === "rightClick" ? "right" : "left",
        count: step.action === "doubleClick" ? 2 : 1,
      });
      return { at: found.label, ...(found.matches > 1 ? { matches: found.matches } : {}) };
    }
    case "hover":
      return { at: (await page.hover(need())).label };
    case "type":
      await page.type(required(step, "input") as string, at, step.clear ?? false);
      return {};
    case "press":
      await page.press(parseKeys(required(step, "keys") as string));
      return {};
    case "scroll":
      await page.scroll(step.deltaX ?? 0, step.deltaY ?? (step.deltaX === undefined ? 400 : 0), at);
      return {};
    case "drag": {
      const to = step.to === undefined ? undefined : target(step.to);
      if (to === undefined) throw new Error("drag needs `to`.");
      await page.drag(need(), to);
      return {};
    }
    case "wait":
    case "waitGone":
      await page.waitFor(need(), { gone: step.action === "waitGone", timeoutMs: step.ms ?? 5_000 });
      return {};
    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, step.ms ?? 500));
      return {};
    case "navigate":
      await page.navigate(required(step, "url") as string);
      return {};
    case "reload":
      await page.reload();
      return {};
    case "back":
      await page.back();
      return {};
    case "eval":
      return { value: (await page.evaluate(required(step, "script") as string)) ?? null };
    case "viewport":
      await page.viewport({
        width: required(step, "width") as number,
        height: required(step, "height") as number,
        scale: step.scale ?? 1,
        mobile: step.mobile ?? false,
      });
      return {};
    case "upload":
      await page.upload(
        required(step, "selector") as string,
        required(step, "files") as ReadonlyArray<string>,
      );
      return {};
  }
};

const location = (page: Page) =>
  page
    .evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })")
    .catch(() => ({
      url: "",
      title: "",
    }));

export const UiTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const driver = yield* UiDriver;
    const registry = yield* BusRegistry;
    const orchestrator = yield* Orchestrator;

    // A stopped agent's page closes with it.
    yield* orchestrator.events.pipe(
      Stream.runForEach((event) =>
        event.payload._tag === "AgentStateChanged" &&
        (event.payload.state === "stopped" || event.payload.state === "failed")
          ? driver.close(event.agentId)
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    const mayAct = (caller: AgentId) =>
      orchestrator.agent(caller).pipe(
        Effect.map((agent) => agent.access !== "readOnly"),
        Effect.orElseSucceed(() => false),
      );

    /** The reply with a screenshot attached, also saved to disk for harnesses that drop images. */
    const withShot = (
      caller: AgentId,
      text: Record<string, unknown>,
      shot: {
        readonly take: boolean;
        readonly fullPage?: boolean | undefined;
        readonly crop?: Target | undefined;
      },
      isError = false,
    ): Effect.Effect<RawReply> =>
      Effect.gen(function* () {
        if (!shot.take) return { text, isError };
        const png = yield* driver
          .use(caller, (page) => page.screenshot({ fullPage: shot.fullPage ?? false, of: shot.crop }))
          .pipe(Effect.result);
        if (png._tag === "Failure")
          return { text: { ...text, screenshotError: png.failure.message }, isError };
        const path = yield* driver.save(caller, png.success);
        return { text: { ...text, screenshot: path }, image: png.success, isError };
      });

    yield* registerRawTool({
      name: "ui_open",
      registry,
      description:
        "Open a web page in a browser Cerium drives for you (headless Edge or Chrome), or attach to a running app's" +
        " debugging port, so you can see and use the UI you are building. Answers with a screenshot. Opening again" +
        " reuses your browser. Follow with ui_act to click, type and check the result in one call.",
      parameters: OpenInput,
      handle: (caller, input) =>
        Effect.gen(function* () {
          const opened = yield* driver.open(caller, input).pipe(Effect.result);
          if (opened._tag === "Failure") return failure(opened.failure.message);
          return yield* withShot(caller, { opened: opened.success }, { take: input.screenshot ?? true });
        }),
    });

    yield* registerRawTool({
      name: "ui_act",
      registry,
      description:
        "Act on your open page like a user: a batch of steps (click, type, press keys, scroll, drag, wait for text," +
        " navigate, resize, run a script, upload files), then a screenshot of the result. Batch every step you can" +
        " predict into one call. A failing step stops the rest, names what it could not find, and still answers with" +
        " a screenshot. Targets are found by visible text or accessible name, a CSS selector, or a point.",
      parameters: ActInput,
      handle: (caller, input) =>
        Effect.gen(function* () {
          if (!(yield* mayAct(caller)))
            return failure("Read-only agents can look at a page but not act on it.");
          const ran = yield* driver
            .use(caller, async (page) => {
              const results: Array<Record<string, unknown>> = [];
              for (const [index, step] of input.steps.entries()) {
                try {
                  results.push({ step: index + 1, action: step.action, ...(await runStep(page, step)) });
                  await page.settle();
                } catch (error) {
                  return {
                    results,
                    failed: {
                      step: index + 1,
                      action: step.action,
                      error: error instanceof Error ? error.message : String(error),
                    },
                    ...(await location(page)),
                    console: page.drainConsole(),
                  };
                }
              }
              return { results, ...(await location(page)), console: page.drainConsole() };
            })
            .pipe(Effect.result);
          if (ran._tag === "Failure") return failure(ran.failure.message);
          return yield* withShot(
            caller,
            ran.success,
            {
              take: input.screenshot ?? true,
              fullPage: input.fullPage,
              crop: input.crop && target(input.crop),
            },
            "failed" in ran.success,
          );
        }),
    });

    yield* registerRawTool({
      name: "ui_screenshot",
      registry,
      readOnly: true,
      description: "Screenshot your open page: the viewport, the whole page, or one element.",
      parameters: ScreenshotInput,
      handle: (caller, input) =>
        Effect.gen(function* () {
          const where = yield* driver.use(caller, location).pipe(Effect.result);
          if (where._tag === "Failure") return failure(where.failure.message);
          return yield* withShot(caller, where.success, {
            take: true,
            fullPage: input.fullPage,
            crop: input.crop && target(input.crop),
          });
        }),
    });

    yield* registerRawTool({
      name: "ui_inspect",
      registry,
      readOnly: true,
      description:
        "Read your open page as text: its URL and title, the visible controls, headings and dialogs with their names," +
        " boxes and states (disabled, checked, expanded, focused), and the console messages and errors since last asked.",
      parameters: InspectInput,
      handle: (caller, input) =>
        driver
          .use(caller, async (page) => ({
            ...((await page.inspect(input.text ?? false)) as object),
            console: page.drainConsole(),
          }))
          .pipe(
            Effect.map((text): RawReply => ({ text })),
            Effect.catch((error) => Effect.succeed(failure(error.message))),
          ),
    });

    yield* registerRawTool({
      name: "ui_close",
      registry,
      description:
        "Close your page and the browser Cerium started for it. Pages also close when you stop or sit unused.",
      parameters: Schema.Struct({}),
      handle: (caller) => driver.close(caller).pipe(Effect.map((closed): RawReply => ({ text: { closed } }))),
    });
  }),
);
