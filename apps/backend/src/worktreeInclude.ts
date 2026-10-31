// Which git-ignored files a new worktree copies from its project, read from an include list in
// gitignore's syntax. Git lists the ignored files and folders without going into those folders, and
// these rules pick from that list: asking git to match the list itself walks every ignored folder,
// node_modules included, which on Windows (where git follows bun's workspace links) took a minute.

import ignore from "ignore";

/** One line of an include list. */
interface Rule {
  readonly negated: boolean;
  /** Matches folders only: the line ended with a slash. */
  readonly folderOnly: boolean;
  /** Matches from the repository's root: the line has a slash before its end. */
  readonly anchored: boolean;
  /** Each path segment's pattern, or `**` for any number of segments. */
  readonly segments: ReadonlyArray<RegExp | "**">;
}

const escape = (char: string) => char.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

/** A glob segment as a regular expression: `*` and `?` stay within it, `[…]` is a character class. */
const segmentPattern = (glob: string): RegExp => {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "\\" && index + 1 < glob.length) {
      source += escape(glob[++index]!);
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 2);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      const body = glob.slice(index + 1, end).replaceAll("\\", "\\\\");
      source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = end;
    } else {
      source += escape(char);
    }
  }
  return new RegExp(`^${source}$`);
};

const parseRule = (line: string): Rule | undefined => {
  let text = line.replace(/(?<!\\)\s+$/, "");
  if (text === "" || text.startsWith("#")) return undefined;
  const negated = text.startsWith("!");
  if (negated) text = text.slice(1);
  else if (text.startsWith("\\!") || text.startsWith("\\#")) text = text.slice(1);
  const folderOnly = text.endsWith("/");
  if (folderOnly) text = text.slice(0, -1);
  const anchored = text.includes("/");
  if (text.startsWith("/")) text = text.slice(1);
  if (text === "") return undefined;
  const segments = text
    .split("/")
    .filter((segment, index, all) => segment !== "**" || all[index - 1] !== "**")
    .map((segment) => (segment === "**" ? ("**" as const) : segmentPattern(segment)));
  return { negated, folderOnly, anchored, segments };
};

/** Whether `rule` can match something inside the folder `path`, its segments matching the folder's so far. */
const reachesFrom = (
  rule: Rule["segments"],
  at: number,
  path: ReadonlyArray<string>,
  from: number,
): boolean => {
  if (from === path.length) return at < rule.length;
  if (at === rule.length) return false;
  const segment = rule[at]!;
  if (segment === "**") return true;
  return segment.test(path[from]!) && reachesFrom(rule, at + 1, path, from + 1);
};

export interface IncludeList {
  /** Whether the list takes `path` (relative to the root, `/`-separated), or a folder it sits in. */
  readonly includes: (path: string, folder: boolean) => boolean;
  /**
   * Whether a line names something inside the folder `path` without taking the whole folder, so the
   * folder is worth looking into. Only lines with a slash reach into a folder git ignores whole; a
   * bare name like `.env` matches at any depth of the folders git doesn't ignore.
   */
  readonly reachesInto: (path: string) => boolean;
}

const segmentsOf = (path: string) => path.split("/").filter((segment) => segment !== "");

/** The include list `lines` (a `.worktreeinclude`'s, or the default patterns) as rules to match by. */
export const includeList = (lines: ReadonlyArray<string>): IncludeList => {
  const rules = lines.flatMap((line) => parseRule(line) ?? []);
  const matcher = ignore({ ignorecase: false }).add(lines);
  return {
    includes: (path, folder) => {
      const segments = segmentsOf(path);
      return segments.length > 0 && matcher.ignores(`${segments.join("/")}${folder ? "/" : ""}`);
    },
    reachesInto: (path) => {
      const segments = segmentsOf(path);
      return rules.some(
        (rule) => !rule.negated && rule.anchored && reachesFrom(rule.segments, 0, segments, 0),
      );
    },
  };
};
