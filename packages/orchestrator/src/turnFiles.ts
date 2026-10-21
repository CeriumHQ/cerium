import type { AgentId, TurnFile } from "@cerium/protocol";

import type { SnapshotChange, SnapshotLines } from "./services.ts";

// The files one of an agent's turns changed, for the summary under its response. Comparing the
// folder's snapshots from before and after the turn finds every change, whatever made it: an edit
// tool, or a heredoc, `sed` or a script the agent ran. The folder may be shared with other agents
// (another thread, or this one's children), so a file is the turn's only when this agent's edit tools
// named it, or a command it ran could have changed it and no other agent was working there meanwhile,
// unless the command names the file.

/** Files a summary lists; the rest are counted. */
export const MAX_TURN_FILES = 200;

/** Turns and named files older than this, of agents no longer working there, are forgotten. */
const KEEP_FOR = 60 * 60 * 1000;

interface Span {
  readonly agentId: AgentId;
  readonly start: number;
  end?: number;
}

interface Named {
  readonly agentId: AgentId;
  readonly at: number;
  readonly path: string;
}

/** Who worked in one folder when, and the files each one's edit tools named: in memory, for a while. */
export class FolderActivity {
  private readonly spans: Array<Span> = [];
  private readonly named: Array<Named> = [];

  /** An agent's turn began at `at`. */
  begin(agentId: AgentId, at: number): void {
    this.spans.push({ agentId, start: at });
  }

  /** The agent's turn that began at `start` ended at `at`. */
  end(agentId: AgentId, start: number, at: number): void {
    const span = this.spans.find((each) => each.agentId === agentId && each.start === start);
    if (span !== undefined) span.end = at;
    this.prune(at);
  }

  /** The agent's edit tools changed `path`, relative to the folder. */
  name(agentId: AgentId, at: number, path: string): void {
    this.named.push({ agentId, at, path });
  }

  /** Whether another agent worked in the folder at some point from `start` to `end`. */
  shared(agentId: AgentId, start: number, end: number): boolean {
    return this.spans.some(
      (span) =>
        span.agentId !== agentId && span.start <= end && (span.end === undefined || span.end >= start),
    );
  }

  /** The files `agentId`'s edit tools named from `start` to `end`, or other agents' when `others`. */
  namedBy(agentId: AgentId, start: number, end: number, others: boolean): ReadonlySet<string> {
    return new Set(
      this.named
        .filter((each) => (each.agentId !== agentId) === others && each.at >= start && each.at <= end)
        .map((each) => each.path),
    );
  }

  /** Forgets what ended long ago, keeping what any turn still running may ask about. */
  private prune(now: number): void {
    const running = this.spans.filter((span) => span.end === undefined).map((span) => span.start);
    const horizon = Math.min(now - KEEP_FOR, ...running);
    const spans = this.spans.filter((span) => span.end === undefined || span.end >= horizon);
    this.spans.splice(0, this.spans.length, ...spans);
    const named = this.named.filter((each) => each.at >= horizon);
    this.named.splice(0, this.named.length, ...named);
  }
}

/** What a turn did that tells its files apart from others'. */
export interface TurnWork {
  /** The files its edit tools named, relative to the folder. */
  readonly named: ReadonlySet<string>;
  /** The commands it ran, as written. */
  readonly commands: ReadonlyArray<string>;
  /** The files other agents' edit tools named meanwhile. */
  readonly namedByOthers: ReadonlySet<string>;
  /** Another agent worked in the folder meanwhile. */
  readonly shared: boolean;
}

/** Whether a command names `path`, relative to the folder: in full, or by its file name. */
const mentions = (commands: ReadonlyArray<string>, path: string): boolean => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const backslashed = path.replaceAll("/", "\\");
  return commands.some((command) => {
    if (command.includes(path) || command.includes(backslashed)) return true;
    // The name alone counts as a word of its own: `a.ts` doesn't name `data.ts`.
    let at = command.indexOf(name);
    while (at !== -1) {
      const before = command[at - 1];
      const after = command[at + name.length];
      if (
        (before === undefined || !/[\w.-]/.test(before)) &&
        (after === undefined || !/[\w.-]/.test(after))
      ) {
        return true;
      }
      at = command.indexOf(name, at + 1);
    }
    return false;
  });
};

/**
 * The files of those that differ between a turn's snapshots that the turn changed, sorted by path,
 * with their lines; at most `MAX_TURN_FILES`, and how many more.
 */
export const turnFiles = (
  differing: ReadonlyArray<SnapshotChange>,
  lines: ReadonlyArray<SnapshotLines>,
  work: TurnWork,
): { readonly files: ReadonlyArray<TurnFile>; readonly more: number } => {
  const counts = new Map(lines.map((each) => [each.path, each]));
  const files: Array<TurnFile> = [];
  for (const { path, change } of differing) {
    let via: TurnFile["via"];
    if (work.named.has(path)) via = "edit";
    else if (
      work.commands.length > 0 &&
      !work.namedByOthers.has(path) &&
      (!work.shared || mentions(work.commands, path))
    ) {
      via = "command";
    } else continue;
    const count = counts.get(path);
    files.push({
      path,
      change,
      ...(count?.added === undefined ? {} : { added: count.added }),
      ...(count?.removed === undefined ? {} : { removed: count.removed }),
      via,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files: files.slice(0, MAX_TURN_FILES), more: Math.max(0, files.length - MAX_TURN_FILES) };
};

/** The command a tool call runs, when it runs one: Claude's `Bash`, Codex's `exec_command` and the like. */
export const commandOf = (toolName: string, input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  const command = fields["command"] ?? fields["cmd"] ?? fields["script"];
  if (typeof command === "string" && command.trim() !== "") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  // A shell tool whose input names its command otherwise still ran one.
  return /bash|shell|powershell|exec|terminal|command/i.test(toolName) ? toolName : undefined;
};
