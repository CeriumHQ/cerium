// What Cerium reads of a project's `.cerium.toml`, and how it writes its own sections back. The file is
// the team's, checked into the repository, so only two sections are Cerium's: `[scripts]` (the
// commands of `setup`, `run`, and the `teardown` kept for them) and `[actions]` (named commands, one
// `name = "command"` each). Everything else in it, comments and blank lines included, is left as it
// is. A reader of a whole TOML file isn't needed for that: lines are scanned for the section
// headers and the `key = "string"` entries under them.

/** A `key = value` line of the file, or the lines of a multi-line string value that starts on one. */
interface Entry {
  /** The header it sits under, as `scripts` or `scripts.more`; empty before the first header. */
  readonly section: string;
  readonly key: string;
  /** The string it holds; undefined for a value that isn't a single-line string (a number, an array). */
  readonly value: string | undefined;
  readonly from: number;
  readonly to: number;
  /** The comment after a single-line entry, with its `#`; empty when it has none. */
  readonly comment: string;
}

interface Scan {
  readonly headers: ReadonlyArray<{ readonly name: string; readonly line: number }>;
  readonly entries: ReadonlyArray<Entry>;
  /** The sections set at the top of the file (`scripts.run = …`, an inline table), which a header of their own would repeat. */
  readonly inlined: ReadonlySet<string>;
}

const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** The string that starts at `at`, basic (`"…"`, with escapes) or literal (`'…'`), and where it ends. */
const readString = (
  text: string,
  at: number,
): { readonly value: string; readonly end: number } | undefined => {
  const quote = text[at];
  if (quote === "'") {
    const close = text.indexOf("'", at + 1);
    return close < 0 ? undefined : { value: text.slice(at + 1, close), end: close + 1 };
  }
  if (quote !== '"') return undefined;
  let value = "";
  for (let index = at + 1; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') return { value, end: index + 1 };
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = text[++index];
    if (next === undefined) return undefined;
    const plain = ESCAPES[next];
    if (plain !== undefined) {
      value += plain;
    } else if (next === "u" || next === "U") {
      const digits = text.slice(index + 1, index + 1 + (next === "u" ? 4 : 8));
      if (!/^[0-9A-Fa-f]+$/.test(digits) || digits.length !== (next === "u" ? 4 : 8)) return undefined;
      const point = Number.parseInt(digits, 16);
      if (point > 0x10ffff) return undefined;
      value += String.fromCodePoint(point);
      index += digits.length;
    } else {
      return undefined;
    }
  }
  return undefined;
};

const HEADER = /^\s*(\[\[?)\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** A header's name without the spaces and quotes TOML allows around its dotted parts. */
const sectionName = (open: string, raw: string): string =>
  (open === "[[" ? "[[" : "") + raw.replace(/\s+/g, "").replace(/["']/g, "");

const scan = (lines: ReadonlyArray<string>): Scan => {
  const headers: Array<{ name: string; line: number }> = [];
  const entries: Entry[] = [];
  let section = "";
  const inlined = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const header = HEADER.exec(line);
    if (header !== null) {
      section = sectionName(header[1]!, header[2]!);
      headers.push({ name: section, line: index });
      continue;
    }
    const start = line.length - line.trimStart().length;
    let key: string | undefined;
    let after = start;
    if (line[start] === '"' || line[start] === "'") {
      const quoted = readString(line, start);
      if (quoted !== undefined) {
        key = quoted.value;
        after = quoted.end;
      }
    } else {
      const bare = BARE_KEY.exec(line.slice(start));
      if (bare !== null) {
        key = bare[0];
        after = start + bare[0].length;
      }
    }
    if (key === undefined) continue;
    const equals = /^\s*=\s*/.exec(line.slice(after));
    if (equals === null) {
      // A dotted key (`scripts.run = …`) at the top of the file defines the table without a header.
      if (section === "" && line[after] === ".") inlined.add(key);
      continue;
    }
    const valueAt = after + equals[0].length;
    const delimiter = line.startsWith('"""', valueAt) ? '"""' : line.startsWith("'''", valueAt) ? "'''" : "";
    if (delimiter !== "") {
      // A multi-line string runs to the line that closes it; what it holds is nobody's but its key's.
      let to = index;
      let closed = line.indexOf(delimiter, valueAt + 3) >= 0;
      while (!closed && to + 1 < lines.length) closed = lines[++to]!.includes(delimiter);
      entries.push({ section, key, value: undefined, from: index, to, comment: "" });
      index = to;
      continue;
    }
    const string = readString(line, valueAt);
    const rest = string === undefined ? undefined : /^\s*(#.*)?$/.exec(line.slice(string.end));
    if (string === undefined || rest === null || rest === undefined) {
      if (section === "") inlined.add(key);
      entries.push({ section, key, value: undefined, from: index, to: index, comment: "" });
    } else {
      entries.push({ section, key, value: string.value, from: index, to: index, comment: rest[1] ?? "" });
    }
  }
  return { headers, entries, inlined };
};

const splitLines = (text: string) => {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length);
  return { bom, eol: body.includes("\r\n") ? "\r\n" : "\n", lines: body.split(/\r?\n/) };
};

/** One named command of the file's `[actions]`. */
export interface FileAction {
  readonly name: string;
  readonly command: string;
}

/** What Cerium reads of a `.cerium.toml`: `[scripts]`' string entries by key, and `[actions]`' in file order. */
export interface ProjectFile {
  readonly scripts: Readonly<Record<string, string>>;
  readonly actions: ReadonlyArray<FileAction>;
}

/**
 * The commands a `.cerium.toml` holds, written plainly, with quotes or as a literal string, a comment
 * allowed after each. Sections other than `[scripts]` and `[actions]` aren't read, nor are their
 * subsections (`[scripts.more]`); an action with no command is left out.
 */
export const readProjectFile = (text: string): ProjectFile => {
  const { lines } = splitLines(text);
  const scripts: Record<string, string> = {};
  const actions: FileAction[] = [];
  for (const entry of scan(lines).entries) {
    if (entry.value === undefined) continue;
    if (entry.section === "scripts") scripts[entry.key] = entry.value;
    else if (entry.section === "actions" && entry.value.trim() !== "" && entry.key.trim() !== "") {
      const known = actions.findIndex((each) => each.name === entry.key);
      if (known < 0) actions.push({ name: entry.key, command: entry.value });
      else actions[known] = { name: entry.key, command: entry.value };
    }
  }
  return { scripts, actions };
};

/**
 * A command as a TOML string: in double quotes when it has nothing to escape, else as a literal
 * string (so a Windows path or a quoted argument stays as typed), else a double-quoted one with
 * its escapes.
 */
export const tomlString = (value: string): string => {
  let control = false;
  for (let at = 0; at < value.length && !control; at++) {
    const code = value.charCodeAt(at);
    control = code < 0x20 || code === 0x7f;
  }
  if (!/["\\]/.test(value) && !control) return `"${value}"`;
  if (!value.includes("'") && !control) return `'${value}'`;
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
};

/** A key as TOML writes it: bare when it can be, else quoted. */
const tomlKey = (key: string): string => (/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key));

/** Why a `.cerium.toml` can't take Cerium's sections as they are; `message` is written for the user. */
export class ProjectFileError extends Error {
  override readonly name = "ProjectFileError";
}

/**
 * Sets, removes and adds the entries of one section, leaving every other line as it was. `wanted`
 * maps a key to its new command, or to null to remove it; with `exact`, an entry it doesn't name goes
 * too. A section left with nothing but its header goes with it, and a missing one is added at the end.
 */
const patchSection = (
  text: string,
  section: string,
  wanted: ReadonlyMap<string, string | null>,
  exact: boolean,
): string => {
  const { bom, eol, lines } = splitLines(text);
  const before = scan(lines);
  const adds = [...wanted].filter((pair): pair is [string, string] => pair[1] !== null);
  const written = ([key, value]: readonly [string, string]) => `${tomlKey(key)} = ${tomlString(value)}`;

  if (before.headers.every((each) => each.name !== section)) {
    if (adds.length === 0) return text;
    if (before.inlined.has(section)) {
      throw new ProjectFileError(
        `The project's .cerium.toml sets ${section} without a [${section}] section, which Cerium can't edit. Change it by hand.`,
      );
    }
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end--;
    const head = lines.slice(0, end);
    return (
      bom + [...head, ...(head.length > 0 ? [""] : []), `[${section}]`, ...adds.map(written), ""].join(eol)
    );
  }

  const own = before.entries.filter((entry) => entry.section === section);
  const seen = new Set<string>();
  // From the bottom up, so the lines above an edit keep their numbers.
  for (const entry of [...own].reverse()) {
    const first = !own.some((other) => other.key === entry.key && other.from < entry.from);
    const next = wanted.get(entry.key);
    const keep = first && (next === undefined ? !exact : next !== null);
    if (!keep) {
      lines.splice(entry.from, entry.to - entry.from + 1);
    } else if (next !== undefined && next !== null) {
      const indent = /^\s*/.exec(lines[entry.from]!)![0];
      const comment = entry.comment === "" ? "" : ` ${entry.comment}`;
      lines.splice(entry.from, entry.to - entry.from + 1, `${indent}${written([entry.key, next])}${comment}`);
      seen.add(entry.key);
    }
  }

  const edited = scan(lines);
  const at = edited.headers.find((each) => each.name === section)!;
  const left = edited.entries.filter((entry) => entry.section === section);
  const added = adds.filter(([key]) => !seen.has(key)).map(written);
  lines.splice((left.at(-1)?.to ?? at.line) + 1, 0, ...added);

  // A section nothing is left in (not even a comment) goes, with the blank lines under it.
  if (left.length === 0 && added.length === 0) {
    const stop = scan(lines).headers.find((each) => each.line > at.line)?.line ?? lines.length;
    if (lines.slice(at.line + 1, stop).every((line) => line.trim() === "")) {
      const toEnd = stop === lines.length;
      lines.splice(at.line, stop - at.line);
      // What came before it now ends the file: its blank line goes, the file's last newline stays.
      if (toEnd) while (lines.length > 1 && lines.at(-1) === "" && lines.at(-2) === "") lines.pop();
    }
  }
  return bom + lines.join(eol);
};

/** What `editProjectFile` changes of a `.cerium.toml`. */
export interface FileEdit {
  /** `[scripts]`' entries to set (a command) or take out (null); the others, `teardown` among them, stay. */
  readonly scripts: Readonly<Record<string, string | null>>;
  /** `[actions]` as it should read, in this order; leaving it out leaves the section as it is. */
  readonly actions?: ReadonlyArray<FileAction>;
}

/**
 * A `.cerium.toml`'s text with the edit made to its `[scripts]` and `[actions]` sections, and nothing
 * else of it touched: other sections, comments, blank lines, the line endings and a byte-order mark
 * stay as they were. An empty `text` is a file to be made.
 */
export const editProjectFile = (text: string, edit: FileEdit): string => {
  let out = patchSection(text, "scripts", new Map(Object.entries(edit.scripts)), false);
  if (edit.actions !== undefined) {
    const names = new Map<string, string | null>(edit.actions.map((action) => [action.name, action.command]));
    out = patchSection(out, "actions", names, true);
  }
  return out;
};
