// Minimal, comment-preserving edits to a TOML file, for the few keys the hub sets in a project's
// `.codex/config.toml` (Codex's app-server only writes the user's own file). Each edit touches only the
// lines of the key it sets; the user's comments, order and layout stay. It understands standard
// `[table]` headers and `key = value` lines, values spanning lines included; anything it can't place
// safely (a table defined inline or by dotted keys) it refuses, and the caller has Codex read the
// result back before keeping it.

export type TomlValue =
  | string
  | number
  | boolean
  | ReadonlyArray<TomlValue>
  | { readonly [key: string]: TomlValue };

/** A key as TOML spells it: bare when it can be, quoted otherwise. */
export const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** A value as TOML spells it on one line. JSON's string escapes are valid in TOML's basic strings. */
export const tomlValue = (value: TomlValue): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  const entries = Object.entries(value as { readonly [key: string]: TomlValue });
  return entries.length === 0
    ? "{}"
    : `{ ${entries.map(([key, each]) => `${tomlKey(key)} = ${tomlValue(each)}`).join(", ")} }`;
};

/** The parts of a dotted key, unquoted: `mcp_servers."my server"` is `["mcp_servers", "my server"]`. */
export const keyPath = (text: string): ReadonlyArray<string> | undefined => {
  const parts: Array<string> = [];
  let rest = text.trim();
  while (rest !== "") {
    let part: string;
    if (rest.startsWith('"')) {
      const end = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (end === null) return undefined;
      part = JSON.parse(`"${end[1]}"`) as string;
      rest = rest.slice(end[0].length).trim();
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end === -1) return undefined;
      part = rest.slice(1, end);
      rest = rest.slice(end + 1).trim();
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(rest);
      if (bare === null) return undefined;
      part = bare[0];
      rest = rest.slice(part.length).trim();
    }
    parts.push(part);
    if (rest === "") break;
    if (!rest.startsWith(".")) return undefined;
    rest = rest.slice(1).trim();
  }
  return parts;
};

const samePath = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((part, index) => part === b[index]);

/** A `[table]` or `[[array]]` header line's path, or `undefined` when the line isn't one. */
const headerOf = (
  line: string,
): { readonly path: ReadonlyArray<string>; readonly array: boolean } | undefined => {
  const match = /^\s*(\[\[?)\s*(.+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (match === null) return undefined;
  const path = keyPath(match[2] ?? "");
  return path === undefined ? undefined : { path, array: match[1] === "[[" };
};

/** The key a `key = value` line sets, as its dotted parts. */
const assignmentOf = (line: string): ReadonlyArray<string> | undefined => {
  const match = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=/.exec(line);
  return match === null ? undefined : keyPath(match[1] ?? "");
};

/** How many lines a value starting on `lines[start]` spans, following brackets and multi-line strings. */
const valueSpan = (lines: ReadonlyArray<string>, start: number): number => {
  let depth = 0;
  let multiline: string | undefined;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? "";
    let column = index === start ? line.indexOf("=") + 1 : 0;
    while (column < line.length) {
      if (multiline !== undefined) {
        const end = line.indexOf(multiline, column);
        if (end === -1) break;
        column = end + 3;
        multiline = undefined;
        continue;
      }
      const char = line[column];
      if (line.startsWith('"""', column) || line.startsWith("'''", column)) {
        multiline = line.slice(column, column + 3);
        column += 3;
      } else if (char === '"' || char === "'") {
        const close =
          char === '"' ? /^"(?:[^"\\]|\\.)*"/.exec(line.slice(column)) : /^'[^']*'/.exec(line.slice(column));
        column += close === null ? line.length : close[0].length;
      } else if (char === "#") {
        break;
      } else {
        if (char === "[" || char === "{") depth++;
        if (char === "]" || char === "}") depth--;
        column++;
      }
    }
    if (depth <= 0 && multiline === undefined) return index - start + 1;
  }
  return lines.length - start;
};

const isBlank = (line: string) => /^\s*(#.*)?$/.test(line);

/** Raised when an edit can't be placed without risking the file's meaning. */
export class TomlEditError extends Error {}

/**
 * Sets `key` in the `[table]` at `table` to `value`, or removes it when `value` is `undefined`. A
 * missing table is added at the end; one left with no keys is removed.
 */
export const setTomlKey = (
  text: string,
  table: ReadonlyArray<string>,
  key: string,
  value: TomlValue | undefined,
): string => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const line = value === undefined ? "" : `${tomlKey(key)} = ${tomlValue(value)}`;

  // The table must not also be defined some other way: inline (`name = { … }`) or by dotted keys.
  let current: ReadonlyArray<string> = [];
  for (const each of lines) {
    const header = headerOf(each);
    if (header !== undefined) {
      current = header.path;
      continue;
    }
    const assigned = assignmentOf(each);
    if (assigned === undefined) continue;
    const full = [...current, ...assigned];
    const prefix = full.slice(0, table.length);
    if (samePath(prefix, table) && !samePath(current.slice(0, table.length), table)) {
      throw new TomlEditError(`[${table.join(".")}] is written in a form Cerium doesn't edit`);
    }
    if (full.length < table.length && samePath(full, table.slice(0, full.length))) {
      throw new TomlEditError(`[${table.join(".")}] is written in a form Cerium doesn't edit`);
    }
  }

  const start = lines.findIndex((each) => {
    const header = headerOf(each);
    return header !== undefined && !header.array && samePath(header.path, table);
  });
  if (start === -1) {
    if (value === undefined) return text;
    const body = lines.length > 0 && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
    const gap = body.length > 0 && !isBlank(body.at(-1) ?? "") ? [""] : [];
    return [...body, ...gap, `[${table.map(tomlKey).join(".")}]`, line, ""].join(eol);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (headerOf(lines[index] ?? "") !== undefined) {
      end = index;
      break;
    }
  }

  let lastKey = start;
  for (let index = start + 1; index < end; index++) {
    const assigned = assignmentOf(lines[index] ?? "");
    if (assigned === undefined) continue;
    const span = valueSpan(lines, index);
    if (samePath(assigned, [key])) {
      // Keep a comment that trails the old value's line.
      const trailing = span === 1 ? (/\s+#.*$/.exec(stripStrings(lines[index] ?? ""))?.[0] ?? "") : "";
      const replaced = value === undefined ? [] : [`${line}${trailing}`];
      const next = [...lines.slice(0, index), ...replaced, ...lines.slice(index + span)];
      return value === undefined ? dropEmptyTable(next, start).join(eol) : next.join(eol);
    }
    lastKey = index + span - 1;
    index += span - 1;
  }
  if (value === undefined) return text;
  return [...lines.slice(0, lastKey + 1), line, ...lines.slice(lastKey + 1)].join(eol);
};

/** The line with its strings blanked, so a `#` inside one isn't taken for a comment. */
const stripStrings = (line: string) =>
  line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (match) => `"${" ".repeat(Math.max(0, match.length - 2))}"`);

/** Removes the table whose header is at `start` when no key is left under it. */
const dropEmptyTable = (lines: ReadonlyArray<string>, start: number): ReadonlyArray<string> => {
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (headerOf(lines[index] ?? "") !== undefined) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  if (body.some((each) => !isBlank(each))) return lines;
  // The blank line before the next table goes with it, so the gaps between tables stay single.
  return [...lines.slice(0, start), ...lines.slice(end)].filter(
    (each, index, all) => !(index === all.length - 1 && each === "" && all[index - 1] === ""),
  );
};

/** Whether the file has a `[table]` at `table`, or any table under it. */
export const hasTable = (text: string, table: ReadonlyArray<string>) =>
  text.split(/\r?\n/).some((line) => {
    const header = headerOf(line);
    return header !== undefined && samePath(header.path.slice(0, table.length), table);
  });

/** Adds a `[table]` holding `entries` at the end of the file. */
export const appendTomlTable = (
  text: string,
  table: ReadonlyArray<string>,
  entries: { readonly [key: string]: TomlValue },
): string => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text.replace(/(\r?\n)+$/, "");
  const lines = [
    `[${table.map(tomlKey).join(".")}]`,
    ...Object.entries(entries).map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`),
  ];
  return `${body === "" ? "" : `${body}${eol}${eol}`}${lines.join(eol)}${eol}`;
};
