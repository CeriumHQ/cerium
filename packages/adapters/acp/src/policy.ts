import type { McpServerSpec, PermissionDecision } from "@cerium/harness";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";

import type {
  McpServer,
  PermissionOption,
  SessionConfigOption,
  SessionConfigSelectOption,
  ToolKind,
} from "./schema.ts";
import type { ToolCallState } from "./translate.ts";

// How Cerium's MCP servers, access modes, approvals and efforts map onto ACP. ACP itself has no access
// modes: an agent asks `session/request_permission` before what its own settings say needs asking, and
// Cerium answers by the access mode. Each harness says which of its session modes fits a mode and
// which flags make it ask about everything (`AcpHarness`), so the answers here are what decide.

/** An injected server as ACP passes it on `session/new`. Header and env maps become name/value lists. */
export const toAcpMcpServer = (name: string, spec: McpServerSpec): McpServer =>
  spec.type === "http"
    ? {
        type: "http",
        name,
        url: spec.url,
        headers: Object.entries(spec.headers ?? {}).map(([header, value]) => ({ name: header, value })),
      }
    : {
        name,
        command: spec.command,
        args: [...spec.args],
        env: Object.entries(spec.env ?? {}).map(([variable, value]) => ({ name: variable, value })),
      };

/** Tool kinds that only read the workspace or the web. */
export const READ_KINDS: ReadonlyArray<ToolKind> = ["read", "search", "fetch", "think"];

/** What Cerium does with a permission request before (or instead of) asking the user. */
export type AutoAnswer = "ask" | "allow" | "deny";

/**
 * The answer an access mode gives a request without the user:
 * - `readOnly`: reading and searching are allowed, everything else is denied.
 * - `ask` and `auto`: reads go through, the rest asks. ACP has no reviewer model, so `auto` asks as `ask`.
 * - `acceptEdits`: as `ask`, with edits inside the workspace allowed.
 * - `fullAccess`: everything is allowed.
 * Calls to trusted servers (Cerium's bus) are always allowed.
 */
export const autoAnswer = (
  access: AccessMode,
  call: ToolCallState,
  context: { readonly trusted: boolean; readonly insideWorkspace: boolean },
): AutoAnswer => {
  if (context.trusted) return "allow";
  if (access === "fullAccess") return "allow";
  const reads = call.kind !== undefined && READ_KINDS.includes(call.kind);
  if (access === "readOnly") return reads ? "allow" : "deny";
  if (reads) return "allow";
  if (access === "acceptEdits" && call.kind === "edit" && context.insideWorkspace) return "allow";
  return "ask";
};

/**
 * The option that carries a decision. A once-only answer never picks an "always" option, which agents
 * save into the user's own settings; a session-wide allow is a once plus Cerium's own memory of the grant
 * (`grantKey`). Undefined when the agent offered none that fits.
 */
export const pickOption = (
  options: ReadonlyArray<PermissionOption>,
  decision: Pick<PermissionDecision, "decision">,
): PermissionOption | undefined => {
  const kinds =
    decision.decision === "allow"
      ? (["allow_once", "allow_always"] as const)
      : (["reject_once", "reject_always"] as const);
  // An agent may file a sticky choice under a once kind (Grok's `enable-always-approve` is `allow_once`
  // and turns on its always-approve mode): a plain once is preferred over anything that says always.
  const sticky = (option: PermissionOption) =>
    /always|yolo|don'?t ask/i.test(`${option.optionId} ${option.name}`);
  for (const kind of kinds) {
    const matching = options.filter((option) => option.kind === kind);
    const found =
      matching.find((option) => !sticky(option)) ?? (kind.endsWith("_once") ? undefined : matching[0]);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * What a session-wide allow covers: the same command for a shell call, the same tool on the same file
 * for an edit, the same tool otherwise.
 */
export const grantKey = (call: ToolCallState, toolName: string, input: unknown): string => {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const command = typeof record["command"] === "string" ? record["command"] : undefined;
  if (call.kind === "execute" && command !== undefined) return `execute:${command}`;
  const path = typeof record["path"] === "string" ? record["path"] : undefined;
  if (call.kind === "edit" || call.kind === "delete" || call.kind === "move") {
    return `${call.kind}:${path ?? toolName}`;
  }
  return `tool:${toolName}`;
};

/** The tool call names a trusted server's tool: `mcp__<server>__…`. */
export const isTrustedTool = (toolName: string, trusted: ReadonlyArray<string>) =>
  trusted.some((server) => toolName.startsWith(`mcp__${server}__`));

const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Words agents use for effort levels, as Cerium's efforts. */
const EFFORT_WORDS: ReadonlyArray<readonly [RegExp, ReasoningEffort]> = [
  [/^(none|off|minimal|min)$/i, "minimal"],
  [/^(low|light|fast)$/i, "low"],
  [/^(medium|med|default|normal|balanced)$/i, "medium"],
  [/^(high|deep)$/i, "high"],
  [/^(xhigh|x-high|extra[- ]?high|very[- ]?high)$/i, "xhigh"],
  [/^(max|maximum|ultra)$/i, "max"],
];

/** A thought-level option value as a Cerium effort, by its value or its name. */
export const effortOf = (
  option: Pick<SessionConfigSelectOption, "value" | "name">,
): ReasoningEffort | undefined => {
  for (const text of [option.value, option.name]) {
    const found = EFFORT_WORDS.find(([pattern]) => pattern.test(text.trim()));
    if (found !== undefined) return found[1];
  }
  return undefined;
};

/** A select option's choices, flattened out of their groups. */
export const selectOptions = (option: SessionConfigOption): ReadonlyArray<SessionConfigSelectOption> => {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "group" in entry ? entry.options : [entry as SessionConfigSelectOption],
  );
};

/** The config option of a category (`model`, `thought_level`), or one whose id says so. */
export const configOption = (
  options: ReadonlyArray<SessionConfigOption> | null | undefined,
  category: "model" | "thought_level" | "mode",
): SessionConfigOption | undefined => {
  const all = options ?? [];
  const aliases: Record<typeof category, RegExp> = {
    model: /^model$/i,
    thought_level: /^(thought_level|reasoning_effort|effort|reasoning|thinking)$/i,
    mode: /^mode$/i,
  };
  return (
    all.find((option) => option.category === category) ??
    all.find((option) => aliases[category].test(option.id))
  );
};

/**
 * The value of a thought-level option for an effort: the same effort, else the nearest one below it,
 * else the lowest above it.
 */
export const effortValue = (option: SessionConfigOption, effort: ReasoningEffort): string | undefined => {
  const offered = selectOptions(option).flatMap((choice) => {
    const level = effortOf(choice);
    return level === undefined ? [] : [{ value: choice.value, rank: EFFORTS.indexOf(level) }];
  });
  if (offered.length === 0) return undefined;
  const wanted = EFFORTS.indexOf(effort);
  const below = offered.filter((choice) => choice.rank <= wanted).sort((a, b) => b.rank - a.rank)[0];
  const above = offered.filter((choice) => choice.rank > wanted).sort((a, b) => a.rank - b.rank)[0];
  return (below ?? above)?.value;
};

/** The efforts a thought-level option offers, lowest first. */
export const effortsOf = (option: SessionConfigOption | undefined): ReadonlyArray<ReasoningEffort> => {
  if (option === undefined) return [];
  const levels = new Set(selectOptions(option).flatMap((choice) => effortOf(choice) ?? []));
  return EFFORTS.filter((effort) => levels.has(effort));
};
