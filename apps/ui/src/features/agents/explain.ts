// A permission request in plain words for someone who may not read the command itself: what the
// agent wants to do, why it says it does, how much could go wrong, and what would change. The risk
// is Cerium's own reading of the request; harnesses don't grade their requests.

export type Risk = "low" | "some" | "high";

/** What a request would do, each with the icon the card shows beside it. */
export type EffectKind =
  | "read"
  | "edit"
  | "create"
  | "delete"
  | "run"
  | "download"
  | "network"
  | "upload"
  | "history"
  | "admin"
  | "tool";

export interface Effect {
  readonly kind: EffectKind;
  readonly text: string;
}

export interface Explained {
  /** What the agent wants to do, as the harness put it. */
  readonly headline: string;
  /** The reason the agent gave, when it gave one the headline doesn't already say. */
  readonly why: string | undefined;
  readonly risk: Risk;
  /** The few things that would change, the riskiest first. */
  readonly effects: ReadonlyArray<Effect>;
}

export interface RequestLike {
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
}

const rank: Record<Risk, number> = { low: 0, some: 1, high: 2 };

/** A request this risky never offers to be allowed for the rest of the chat. */
export const allowsSession = (risk: Risk) => risk !== "high";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A command as one string; harnesses send it as text, as its words, or inside what it is about. */
export const commandOf = (input: unknown): string | undefined => {
  const fields = record(input);
  const command = fields?.["command"] ?? record(fields?.["subject"])?.["command"];
  return Array.isArray(command) && command.every((word) => typeof word === "string")
    ? command.join(" ")
    : textOf(command);
};

const basename = (path: string) => path.split(/[\\/]/).findLast((part) => part !== "") ?? path;

const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

// What one step of a shell command does, checked in order: the first rule that matches decides it.
const commandRules: ReadonlyArray<{ test: RegExp; risk: Risk; effect: Effect }> = [
  {
    test: /^(rm|rmdir|rd|del|erase|unlink|shred|remove-item|ri)\b/,
    risk: "high",
    effect: { kind: "delete", text: "Deletes files for good" },
  },
  { test: /^find\b.*\s-delete\b/, risk: "high", effect: { kind: "delete", text: "Deletes files for good" } },
  {
    test: /^git\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+(--\s+)?\.(\s|$)|restore\s+\.(\s|$)|stash\s+(drop|clear))/,
    risk: "high",
    effect: { kind: "delete", text: "Throws away changes not yet committed" },
  },
  {
    test: /^git\s+push\b.*\s(--force(-with-lease)?|-f)\b/,
    risk: "high",
    effect: { kind: "history", text: "Overwrites history others may share" },
  },
  {
    test: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/,
    risk: "high",
    effect: { kind: "delete", text: "Deletes data from a database" },
  },
  {
    test: /^(mkfs|format|diskpart|dd)\b/,
    risk: "high",
    effect: { kind: "admin", text: "Writes to a disk directly" },
  },
  {
    test: /^(npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx)\b/,
    risk: "some",
    effect: { kind: "download", text: "Downloads a package and runs it" },
  },
  {
    test: /^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/,
    risk: "some",
    effect: { kind: "download", text: "Downloads packages from the internet" },
  },
  {
    test: /^(pip3?|uv|poetry|cargo|go|gem|brew|winget|choco|scoop|apt|apt-get|dnf|yum|pacman|composer|dotnet)\b.*\s(install|add|get)\b/,
    risk: "some",
    effect: { kind: "download", text: "Installs software from the internet" },
  },
  { test: /^git\s+push\b/, risk: "some", effect: { kind: "upload", text: "Uploads your commits" } },
  {
    test: /^git\s+(commit|merge|rebase|pull|cherry-pick|revert|reset|checkout|switch|stash|tag|branch\s+-[dDmM])\b/,
    risk: "some",
    effect: { kind: "history", text: "Changes your git history" },
  },
  {
    test: /^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|rsync|ftp)\b/,
    risk: "some",
    effect: { kind: "network", text: "Connects to the internet" },
  },
  {
    test: /^(mv|move|move-item|ren|rename|rename-item|cp|copy|copy-item|mkdir|md|touch|new-item|ni|set-content|add-content|out-file|tee|sed\s+-i|chmod|chown|icacls)\b/,
    risk: "some",
    effect: { kind: "edit", text: "Changes files" },
  },
  {
    test: /^(kill|pkill|killall|taskkill|stop-process)\b/,
    risk: "some",
    effect: { kind: "run", text: "Stops a running program" },
  },
  {
    test: /^git\s+(status|diff|log|show|blame|describe|rev-parse|ls-files|remote(\s+-v)?$|branch(\s+(-a|-v|-vv|-r|--list|--show-current))*$)/,
    risk: "low",
    effect: { kind: "read", text: "Only reads, changes nothing" },
  },
  {
    test: /^(ls|dir|cat|type|head|tail|less|more|pwd|cd|echo|printf|which|where|whoami|grep|rg|findstr|select-string|find|tree|wc|stat|file|du|df|sort|uniq|diff|date|env|printenv|get-childitem|gci|get-content|gc|get-location|test-path|get-command)\b/,
    risk: "low",
    effect: { kind: "read", text: "Only reads, changes nothing" },
  },
  {
    test: /\s(--version|-v|-V)$/,
    risk: "low",
    effect: { kind: "read", text: "Only reads, changes nothing" },
  },
  {
    test: /^((npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|check|typecheck|format|verify)\b|bun\s+test\b|tsc\b|vitest\b|jest\b|pytest\b|cargo\s+(test|build|check|clippy)\b|go\s+(test|build|vet)\b)/,
    risk: "low",
    effect: { kind: "run", text: "Runs your project's checks" },
  },
];

const anyCommand: Effect = { kind: "run", text: "Runs a command on your computer" };

/** A script fetched and run in one go, which no rule on a single step can see. */
const pipedToShell =
  /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/;

/** Output sent into a file, other than thrown away. */
const writesFile = /(^|[^\d&>])>>?\s*(?!&|\/dev\/null\b|nul\b|\$null\b)\S/;

/** One step of a command: its risk and what it would do. */
const step = (text: string): ReadonlyArray<{ risk: Risk; effect: Effect }> => {
  const elevated = /^(sudo|doas|runas)\s+/.exec(text);
  const rest = elevated ? text.slice(elevated[0].length) : text;
  const rule = commandRules.find(({ test }) => test.test(rest));
  return [
    ...(elevated
      ? [
          {
            risk: "high" as const,
            effect: { kind: "admin" as const, text: "Runs with administrator rights" },
          },
        ]
      : []),
    rule ?? { risk: "some" as const, effect: anyCommand },
    ...(writesFile.test(rest) && rule?.effect.kind !== "edit"
      ? [{ risk: "some" as const, effect: { kind: "edit" as const, text: "Writes to a file" } }]
      : []),
  ];
};

const explainCommand = (command: string) => {
  const lower = command.toLowerCase();
  const steps = lower
    .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return [
    ...(pipedToShell.test(lower)
      ? [
          {
            risk: "high" as const,
            effect: { kind: "download" as const, text: "Runs a script straight from the internet" },
          },
        ]
      : []),
    ...steps.flatMap(step),
  ];
};

/** File changes as a harness describes them: a patch of several files, or one file's edit. */
const explainChanges = (input: unknown) => {
  const changes = record(input)?.["changes"];
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const kinds = changes.map((change: unknown) => {
    const kind = record(change)?.["kind"];
    return textOf(record(kind)?.["type"]) ?? textOf(kind) ?? "update";
  });
  const count = (kind: string) => kinds.filter((each) => each === kind).length;
  const created = count("add");
  const deleted = count("delete");
  const changed = kinds.length - created - deleted;
  return [
    ...(deleted > 0
      ? [
          {
            risk: "some" as const,
            effect: { kind: "delete" as const, text: `Deletes ${plural(deleted, "a file", "files")}` },
          },
        ]
      : []),
    ...(changed > 0
      ? [
          {
            risk: "low" as const,
            effect: { kind: "edit" as const, text: `Changes ${plural(changed, "a file", "files")}` },
          },
        ]
      : []),
    ...(created > 0
      ? [
          {
            risk: "low" as const,
            effect: { kind: "create" as const, text: `Creates ${plural(created, "a file", "files")}` },
          },
        ]
      : []),
  ];
};

const editTools = new Set(["edit", "multiedit", "notebookedit", "write", "apply_patch", "patch"]);
const readTools = new Set(["read", "glob", "grep", "ls", "list", "notebookread", "codebase_search"]);

const explainTool = (toolName: string, input: unknown) => {
  const name = toolName.toLowerCase();
  const fields = record(input);
  const path = textOf(fields?.["file_path"]) ?? textOf(fields?.["notebook_path"]) ?? textOf(fields?.["path"]);
  if (editTools.has(name)) {
    const replaces = name === "write" && fields?.["old_string"] === undefined;
    return [
      {
        risk: "low" as const,
        effect: {
          kind: "edit" as const,
          text: path
            ? `${replaces ? "Writes" : "Changes"} ${basename(path)}`
            : replaces
              ? "Writes a file"
              : "Changes a file",
        },
      },
    ];
  }
  if (readTools.has(name))
    return [{ risk: "low" as const, effect: { kind: "read" as const, text: "Only reads files" } }];
  if (name === "webfetch" || name === "websearch" || name === "web_search") {
    return [
      {
        risk: "low" as const,
        effect: {
          kind: "network" as const,
          text: name === "webfetch" ? "Opens a web page" : "Searches the web",
        },
      },
    ];
  }
  if (name === "external_directory") {
    return [
      {
        risk: "some" as const,
        effect: { kind: "admin" as const, text: "Works outside your project folder" },
      },
    ];
  }
  const network = record(fields?.["network"]);
  const host = textOf(network?.["host"]);
  if (host)
    return [{ risk: "some" as const, effect: { kind: "network" as const, text: `Connects to ${host}` } }];
  const server = (/^mcp__(.+?)__/.exec(toolName) ?? /^mcp__(.+)$/.exec(toolName))?.[1];
  if (server)
    return [{ risk: "some" as const, effect: { kind: "tool" as const, text: `Uses a tool from ${server}` } }];
  return [];
};

/** The headline as the harness wrote it, less a reason it tacked on in brackets or a tool's name. */
const headlineOf = (summary: string, toolName: string, reason: string | undefined) => {
  let line = summary.trim();
  if (reason && line.endsWith(`(${reason})`)) line = line.slice(0, -reason.length - 2).trimEnd();
  const named = `${toolName}: `;
  if (line.startsWith(named) && line.length > named.length) line = line.slice(named.length);
  return line.charAt(0).toUpperCase() + line.slice(1);
};

const said = (headline: string, reason: string | undefined) => {
  if (reason === undefined) return undefined;
  const plain = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return plain(headline).includes(plain(reason)) ? undefined : reason;
};

const MAX_EFFECTS = 3;

export const explainRequest = ({ toolName, summary, input }: RequestLike): Explained => {
  const fields = record(input);
  const reason = textOf(fields?.["reason"]) ?? textOf(fields?.["description"]);
  const headline = headlineOf(summary, toolName, textOf(fields?.["reason"]));
  const command = commandOf(input);
  const found =
    command !== undefined ? explainCommand(command) : (explainChanges(input) ?? explainTool(toolName, input));
  const risk = found.reduce<Risk>(
    (worst, each) => (rank[each.risk] > rank[worst] ? each.risk : worst),
    found.length === 0 ? "some" : "low",
  );
  // "Only reads" stops being true once another step changes something.
  const changes = found.some(({ effect }) => effect.kind !== "read");
  const effects = [...found]
    .sort((a, b) => rank[b.risk] - rank[a.risk])
    .map(({ effect }) => effect)
    .filter((effect) => !(changes && effect.kind === "read"))
    .filter((effect, index, all) => all.findIndex((other) => other.text === effect.text) === index)
    .slice(0, MAX_EFFECTS);
  return { headline, why: said(headline, reason), risk, effects };
};
