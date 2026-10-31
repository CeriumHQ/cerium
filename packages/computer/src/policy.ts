// What agents may ask agent-desktop for through Cerium, and how its answers are put to them. Pure
// logic: the service (computer.ts) runs what passes here.
//
// A step is one agent-desktop command in its batch form, `{ command, args }`, whose `args` are the
// command's flags with hyphens as underscores and its positional argument by its placeholder's name
// (`ref_id`, `text`, `combo`, `app`). agent-desktop itself validates each one before anything runs.

export interface Step {
  readonly command: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** Commands that only look: the screen, its apps and windows, the clipboard. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  "snapshot",
  "find",
  "get",
  "is",
  "screenshot",
  "list-surfaces",
  "list-apps",
  "list-windows",
  "list-displays",
  "list-notifications",
  "clipboard-get",
  "wait",
  "status",
  "permissions",
  "version",
]);

/** Commands that change something on the user's computer. */
export const ACT_COMMANDS: ReadonlySet<string> = new Set([
  "click",
  "double-click",
  "triple-click",
  "right-click",
  "type",
  "set-value",
  "clear",
  "focus",
  "select",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll",
  "scroll-to",
  "press",
  "hover",
  "drag",
  "mouse-move",
  "mouse-click",
  "mouse-wheel",
  "launch",
  "close-app",
  "focus-window",
  "resize-window",
  "move-window",
  "minimize",
  "maximize",
  "restore",
  "open-system-surface",
  "dismiss-notification",
  "dismiss-all-notifications",
  "notification-action",
  "clipboard-set",
  "clipboard-clear",
]);

/** Commands Cerium runs itself or never runs, and what to do instead. */
const REFUSED: Readonly<Record<string, string>> = {
  batch: "Give computer_act several steps instead of a nested batch.",
  session: "Cerium keeps your session itself.",
  "cursor-overlay": "Cerium shows your cursor itself.",
  trace: "Cerium doesn't record traces.",
  skills: "Read them with computer_guide.",
  "key-down": "Held keys aren't supported: use press with a combo such as ctrl+a.",
  "key-up": "Held keys aren't supported: use press with a combo such as ctrl+a.",
  "mouse-down": "Held buttons aren't supported: use mouse-click or drag.",
  "mouse-up": "Held buttons aren't supported: use mouse-click or drag.",
};

/** Arguments Cerium sets or never passes: they write files, pick the session, or skip a guard. */
const REFUSED_ARGS: Readonly<Record<string, string>> = {
  session: "Cerium picks the session.",
  agent_id: "Cerium names you.",
  headed: "Ask for physical input with computer_act's `physical`.",
  screenshot: "Debug pages aren't written.",
  debug: "Debug pages aren't written.",
  trace: "Cerium doesn't record traces.",
  trace_strict: "Cerium doesn't record traces.",
  verbose: "Logs aren't returned.",
  path: "Screenshots come back as images, not files.",
  out: "Nothing is written to files.",
  force:
    "Cerium never forces a guarded shortcut or quit: ask the user to do it, or close the app without force.",
  request: "Ask the user to grant permissions in Settings → Computer use.",
  guide: "Ask the user to grant permissions in Settings → Computer use.",
};

/** The arguments a screenshot takes through Cerium, as the flags agent-desktop reads. */
const SCREENSHOT_FLAGS: Readonly<Record<string, string>> = {
  app: "--app",
  window_id: "--window-id",
  screen: "--screen",
};

/** Why a step can't run, or nothing when it can. */
export const refusal = (step: Step, kind: "read" | "act"): string | undefined => {
  const { command } = step;
  const refused = REFUSED[command];
  if (refused !== undefined) return `\`${command}\` isn't available through Cerium. ${refused}`;
  if (!READ_COMMANDS.has(command) && !ACT_COMMANDS.has(command)) {
    return `\`${command}\` isn't an agent-desktop command Cerium runs. computer_guide lists them.`;
  }
  if (kind === "read" && !READ_COMMANDS.has(command)) {
    return `\`${command}\` changes something: run it with computer_act.`;
  }
  if (kind === "act" && command === "screenshot") {
    return "Take screenshots with computer_read, which returns the image.";
  }
  for (const key of Object.keys(step.args ?? {})) {
    const reason = REFUSED_ARGS[key];
    if (reason !== undefined) return `\`${command}\` with \`${key}\`: ${reason}`;
    if (command === "screenshot" && SCREENSHOT_FLAGS[key] === undefined) {
      return "screenshot takes `app`, `window_id` or `screen` (a display index from list-displays).";
    }
  }
  return undefined;
};

/** A screenshot step as agent-desktop's command line, which prints the image however large. */
export const screenshotArgs = (step: Step): ReadonlyArray<string> => [
  "screenshot",
  ...Object.entries(step.args ?? {}).flatMap(([key, value]) =>
    typeof value === "string" || typeof value === "number" ? [SCREENSHOT_FLAGS[key]!, String(value)] : [],
  ),
];

/** Whether some step only works with real pointer or keyboard input on every platform. */
export const PHYSICAL_COMMANDS: ReadonlySet<string> = new Set([
  "triple-click",
  "hover",
  "drag",
  "mouse-move",
  "mouse-click",
  "mouse-wheel",
]);

/** The most steps one computer_act call runs. */
export const MAX_STEPS = 30;

/** The longest a call's text answer gets before it's cut, in characters. */
export const MAX_TEXT = 80_000;

/** `text`, cut to `MAX_TEXT` with a note on narrowing the next read. */
export const capped = (text: string): string =>
  text.length <= MAX_TEXT
    ? text
    : `${text.slice(0, MAX_TEXT)}\n… cut at ${MAX_TEXT} characters. Narrow it: snapshot with skeleton, interactive_only and compact, then drill in with root.`;

export interface Envelope {
  readonly version?: string;
  readonly ok: boolean;
  readonly command?: string;
  readonly data?: unknown;
  readonly error?: unknown;
}

/** One line of agent-desktop's standard output as its envelope, or nothing when it isn't one. */
export const parseEnvelope = (stdout: string): Envelope | undefined => {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (line === undefined || line === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && typeof (value as Envelope).ok === "boolean"
      ? (value as Envelope)
      : undefined;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** An error's code, such as `POLICY_DENIED`. */
export const errorCode = (error: unknown): string | undefined =>
  isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;

/** One command's answer as the agent reads it: its data, or its error. */
const entryText = (entry: Envelope) =>
  entry.ok
    ? { command: entry.command, ok: true, data: entry.data }
    : { command: entry.command, ok: false, error: entry.error };

/**
 * A batch's answer as the agent reads it: each step's data or error in order, and where it stopped.
 * The batch's own bookkeeping (limits, semantics) is left out.
 */
export const batchText = (envelope: Envelope): string => {
  if (!envelope.ok || !isRecord(envelope.data)) return JSON.stringify({ ok: false, error: envelope.error });
  const data = envelope.data;
  const results = Array.isArray(data["results"]) ? (data["results"] as ReadonlyArray<Envelope>) : [];
  const steps = results.map(entryText);
  return JSON.stringify({
    steps,
    ...(data["stopped"] === undefined ? {} : { stopped: data["stopped"] }),
    ...(typeof data["not_started_entries"] === "number" && data["not_started_entries"] > 0
      ? { notStarted: data["not_started_entries"] }
      : {}),
  });
};

/** Each failed step's error code in a batch's answer. */
export const batchErrorCodes = (envelope: Envelope): ReadonlyArray<string> => {
  if (!isRecord(envelope.data) || !Array.isArray(envelope.data["results"])) {
    return [errorCode(envelope.error)].filter((code) => code !== undefined);
  }
  return (envelope.data["results"] as ReadonlyArray<Envelope>).flatMap((result) =>
    result.ok ? [] : [errorCode(result.error)].filter((code) => code !== undefined),
  );
};

/** A step as a few words for the user, such as `type “hello”` or `press ctrl+s`. */
const stepWords = (step: Step): string => {
  const args = step.args ?? {};
  const said = ["text", "value", "combo", "app", "title"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (said === undefined) return step.command;
  const line = said.trim().split(/\r?\n/, 1)[0]!;
  return `${step.command} “${line.length > 40 ? `${line.slice(0, 39)}…` : line}”`;
};

/** What a run of steps does, for an approval: `click, type “hello”, press ctrl+s`. */
export const stepsSummary = (steps: ReadonlyArray<Step>): string => {
  const words = steps.map(stepWords);
  return words.length > 4 ? `${words.slice(0, 4).join(", ")}, +${words.length - 4}` : words.join(", ");
};
