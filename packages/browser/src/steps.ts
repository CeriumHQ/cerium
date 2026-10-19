import { parseKeys, type Page, type Target } from "./page.ts";

// The steps `bun run ui act` runs, written on the command line as `action`, `action=value` or
// `action@target=value`, or as JSON for what that can't say (a drag, an upload, a target holding `=`).

export type Action =
  | "click"
  | "rightClick"
  | "doubleClick"
  | "hover"
  | "type"
  | "fill"
  | "press"
  | "scroll"
  | "drag"
  | "wait"
  | "waitGone"
  | "sleep"
  | "navigate"
  | "reload"
  | "back"
  | "eval"
  | "viewport"
  | "upload";

const ACTIONS: ReadonlyArray<Action> = [
  "click",
  "rightClick",
  "doubleClick",
  "hover",
  "type",
  "fill",
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
];

/** Actions whose `=value` names their target rather than an input. */
const TARGETED: ReadonlySet<Action> = new Set([
  "click",
  "rightClick",
  "doubleClick",
  "hover",
  "wait",
  "waitGone",
]);

export interface Step {
  readonly action: Action;
  readonly target?: Target | undefined;
  /** drag: where to drop. */
  readonly to?: Target | undefined;
  /** type/fill: the text; press: the keys; navigate: the URL; eval: the script; upload: the files. */
  readonly value?: string | undefined;
  readonly files?: ReadonlyArray<string> | undefined;
  readonly ms?: number | undefined;
}

/** `Send`, `css:#go`, `@120,48`, with `[n]` after any of them for the nth match. */
export const parseTarget = (text: string): Target => {
  const nth = /^(.*)\[(\d+)\]$/s.exec(text);
  const body = nth === null ? text : nth[1]!;
  const index = nth === null ? {} : { nth: Number(nth[2]) };
  const point = /^@(-?[\d.]+),(-?[\d.]+)$/.exec(body);
  if (point !== null) return { x: Number(point[1]), y: Number(point[2]) };
  if (body.startsWith("css:")) return { selector: body.slice(4), ...index };
  return { text: body, ...index };
};

const isAction = (name: string): name is Action => (ACTIONS as ReadonlyArray<string>).includes(name);

/** A JSON step, in the shape the bus's old `ui_act` took: `{ "action": "drag", "text": "A", "to": { "text": "B" } }`. */
const fromJson = (raw: Record<string, any>): Step => {
  if (typeof raw["action"] !== "string" || !isAction(raw["action"])) {
    throw new Error(`Unknown action in ${JSON.stringify(raw)}. Actions: ${ACTIONS.join(", ")}.`);
  }
  const target = (fields: Record<string, any> | undefined): Target | undefined =>
    fields === undefined || (fields["text"] ?? fields["selector"] ?? fields["x"]) === undefined
      ? undefined
      : {
          text: fields["text"],
          selector: fields["selector"],
          nth: fields["nth"],
          x: fields["x"],
          y: fields["y"],
        };
  const value = raw["input"] ?? raw["keys"] ?? raw["url"] ?? raw["script"] ?? raw["value"];
  return {
    action: raw["clear"] === true && raw["action"] === "type" ? "fill" : raw["action"],
    target: target(raw),
    to: target(raw["to"]),
    value:
      raw["action"] === "scroll" && raw["deltaY"] !== undefined
        ? String(raw["deltaY"])
        : raw["action"] === "viewport" && raw["width"] !== undefined
          ? `${raw["width"]}x${raw["height"]}`
          : value === undefined
            ? undefined
            : String(value),
    files: raw["files"],
    ms: raw["ms"],
  };
};

/** One command-line argument as the steps it holds. */
export const parseStep = (arg: string): ReadonlyArray<Step> => {
  const trimmed = arg.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(fromJson);
  }
  const equals = arg.indexOf("=");
  const head = equals === -1 ? arg : arg.slice(0, equals);
  const value = equals === -1 ? undefined : arg.slice(equals + 1);
  const at = head.indexOf("@");
  const name = at === -1 ? head : head.slice(0, at);
  const on = at === -1 ? undefined : head.slice(at + 1);
  if (!isAction(name)) throw new Error(`Unknown step "${arg}". Actions: ${ACTIONS.join(", ")}.`);
  if (TARGETED.has(name)) {
    const named = on ?? value;
    if (named === undefined || named === "") throw new Error(`${name} needs a target: ${name}=Send.`);
    return [
      {
        action: name,
        target: parseTarget(named),
        ...(on !== undefined && value !== undefined ? { ms: Number(value) } : {}),
      },
    ];
  }
  const target = on === undefined ? undefined : parseTarget(on);
  switch (name) {
    case "drag":
      if (target === undefined || value === undefined) throw new Error("drag needs drag@<from>=<to>.");
      return [{ action: name, target, to: parseTarget(value) }];
    case "sleep":
      return [{ action: name, ms: Number(value ?? 500) }];
    case "upload":
      if (on === undefined || value === undefined)
        throw new Error("upload needs upload@css:<input>=<file>,<file>.");
      return [{ action: name, target, files: value.split(",") }];
    default:
      return [{ action: name, target, value }];
  }
};

const need = <A>(step: Step, value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`${step.action} needs ${what}.`);
  return value;
};

/** Runs one step; returns what is worth reporting about it. */
export const runStep = async (page: Page, step: Step): Promise<Record<string, unknown>> => {
  const target = () => need(step, step.target, "a target: text, css:<selector> or @x,y");
  switch (step.action) {
    case "click":
    case "rightClick":
    case "doubleClick": {
      const found = await page.click(target(), {
        button: step.action === "rightClick" ? "right" : "left",
        count: step.action === "doubleClick" ? 2 : 1,
      });
      return { at: found.label, ...(found.matches > 1 ? { matches: found.matches } : {}) };
    }
    case "hover":
      return { at: (await page.hover(target())).label };
    case "type":
    case "fill":
      await page.type(need(step, step.value, "text: type=hello"), step.target, step.action === "fill");
      return {};
    case "press":
      await page.press(parseKeys(need(step, step.value, "keys: press=Enter")));
      return {};
    case "scroll": {
      const delta = Number(step.value ?? 400);
      await page.scroll(0, delta, step.target);
      return {};
    }
    case "drag":
      await page.drag(target(), need(step, step.to, "where to drop"));
      return {};
    case "wait":
    case "waitGone":
      await page.waitFor(target(), { gone: step.action === "waitGone", timeoutMs: step.ms ?? 5_000 });
      return {};
    case "sleep":
      await new Promise((resolve) => setTimeout(resolve, step.ms ?? 500));
      return {};
    case "navigate":
      await page.navigate(need(step, step.value, "a URL"));
      return {};
    case "reload":
      await page.reload();
      return {};
    case "back":
      await page.back();
      return {};
    case "eval":
      return { value: (await page.evaluate(need(step, step.value, "a script"))) ?? null };
    case "viewport": {
      const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(need(step, step.value, "a size: viewport=390x844"));
      if (size === null) throw new Error("viewport takes WIDTHxHEIGHT, with @SCALE after it for a phone.");
      const scale = Number(size[3] ?? 1);
      await page.viewport({ width: Number(size[1]), height: Number(size[2]), scale, mobile: scale > 1 });
      return {};
    }
    case "upload":
      await page.upload(
        need(step, step.target?.selector, "a css:<selector>"),
        need(step, step.files, "files"),
      );
      return {};
  }
};
