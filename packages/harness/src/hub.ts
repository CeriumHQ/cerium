import type {
  HubScope,
  HubSecret,
  HubServer,
  HubServerStatus,
  HubSkill,
  HubSupport,
  HubTargetScope,
  HubTransport,
} from "@cerium/protocol";
import { Effect, FileSystem, Path, Schema } from "effect";
import { applyEdits, modify, parse, type JSONPath, type ParseError } from "jsonc-parser";

import type { HarnessFailure, HarnessUnavailable } from "./adapter.ts";

// The part of an adapter that reads and edits its harness's own MCP and skills config, for the hub.
// Each harness keeps its config in its own files and format; an adapter edits them minimally (the
// user's comments and layout stay), and turns off only what the harness itself can turn off.

/** A server of that name is already configured where a copy would go. */
export class HubConflict extends Schema.TaggedError<HubConflict>()("HubConflict", {
  message: Schema.String,
}) {}

/**
 * A server as it's copied from one harness to another: its shape, with the names of its environment
 * variables and headers but never their values, which the copy leaves empty for the user to fill in.
 */
export interface PortableServer {
  readonly name: string;
  readonly transport: HubTransport;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly url?: string;
  readonly env: ReadonlyArray<string>;
  readonly headers: ReadonlyArray<string>;
}

/** What `HarnessHub.read` finds for a project. */
export interface HubListing {
  readonly servers: ReadonlyArray<HubServer>;
  readonly skills: ReadonlyArray<HubSkill>;
  readonly notice?: string;
}

type HubError = HarnessUnavailable | HarnessFailure;

export interface HarnessHub {
  readonly support: HubSupport;
  /** The servers and skills the harness offers a session in `project`, with what's turned off there. */
  read(project: string): Effect.Effect<HubListing, HubError>;
  /** Each server's connection and tools, as the harness reports them. Present when `support.status` is. */
  status?(project: string): Effect.Effect<ReadonlyArray<HubServerStatus>, HubError>;
  /** Present when `support.servers` isn't `none`. */
  setServer?(project: string, server: HubServer, enabled: boolean): Effect.Effect<void, HubError>;
  /** Present when `support.tools` isn't `none`. */
  setTool?(project: string, server: HubServer, tool: string, enabled: boolean): Effect.Effect<void, HubError>;
  /** Present when `support.skills` isn't `none`. */
  setSkill?(project: string, skill: HubSkill, enabled: boolean): Effect.Effect<void, HubError>;
  /** Adds a server to the harness's config, and resolves with the file it wrote. */
  addServer?(
    project: string,
    scope: HubTargetScope,
    server: PortableServer,
  ): Effect.Effect<string, HubError | HubConflict>;
  /** The folder the harness reads skills from at `scope`, which a copied skill's folder goes in. */
  skillsFolder?(project: string, scope: HubTargetScope): Effect.Effect<string, HubError>;
}

// ---------------------------------------------------------------------------------------------
// Secrets

/**
 * The names of a config's environment variables or headers, and whether each has a value. A list of
 * names (a harness that redacts the values) counts each as set.
 */
export const secretsOf = (values: unknown): ReadonlyArray<HubSecret> =>
  Array.isArray(values)
    ? values.filter((name): name is string => typeof name === "string").map((name) => ({ name, set: true }))
    : isRecord(values)
      ? Object.entries(values).map(([name, value]) => ({
          name,
          set: typeof value === "string" ? value !== "" : value !== null && value !== undefined,
        }))
      : [];

/** The server's shape for a copy: secrets by name only. */
export const portable = (server: HubServer): PortableServer => ({
  name: server.name,
  transport: server.transport,
  ...(server.command !== undefined ? { command: server.command } : {}),
  ...(server.args !== undefined ? { args: server.args } : {}),
  ...(server.url !== undefined ? { url: server.url } : {}),
  env: server.env.map((secret) => secret.name),
  headers: server.headers.map((secret) => secret.name),
});

/** Every name a copy leaves for the user to fill in. */
export const unfilled = (server: PortableServer): ReadonlyArray<string> => [...server.env, ...server.headers];

const blanks = (names: ReadonlyArray<string>) => Object.fromEntries(names.map((name) => [name, ""]));

// ---------------------------------------------------------------------------------------------
// JSON with comments

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses JSON that may hold comments and trailing commas; `undefined` when it isn't valid. */
export const parseJsonc = (text: string): unknown => {
  const errors: Array<ParseError> = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 ? value : undefined;
};

/** The indent the file already uses, so an edit matches it. */
const indentOf = (text: string) => {
  const line = /^([ \t]+)\S/m.exec(text)?.[1];
  if (line?.startsWith("\t")) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: line?.length ?? 2 };
};

/**
 * Sets the value at `path` in a JSON or JSONC file's text, or removes it when `value` is `undefined`,
 * touching only that value: comments, order and layout elsewhere stay as they were.
 */
export const editJsonc = (text: string, path: JSONPath, value: unknown): string => {
  const source = text.trim() === "" ? "{}\n" : text;
  const edits = modify(source, path, value, {
    formattingOptions: { ...indentOf(source), eol: source.includes("\r\n") ? "\r\n" : "\n" },
  });
  return applyEdits(source, edits);
};

const isEmpty = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

/**
 * `editJsonc`, removing the value instead when it's empty, and then each object above it that the
 * removal left empty, so turning something back on leaves no trace of having turned it off.
 */
export const editJsoncPruned = (text: string, path: JSONPath, value: unknown): string => {
  let next = editJsonc(text, path, isEmpty(value) ? undefined : value);
  for (let depth = path.length - 1; depth > 0 && isEmpty(value); depth--) {
    const parent = path.slice(0, depth);
    let at: unknown = parseJsonc(next);
    for (const key of parent) at = isRecord(at) ? at[String(key)] : undefined;
    if (!isRecord(at) || Object.keys(at).length > 0) break;
    next = editJsonc(next, parent, undefined);
  }
  return next;
};

// ---------------------------------------------------------------------------------------------
// The `mcpServers` format Claude Code and Cursor share

/** A server in the `mcpServers` format (`.mcp.json`, `~/.claude.json`, Cursor's `mcp.json`). */
export const fromMcpJson = (
  name: string,
  value: unknown,
  scope: HubScope,
  file: string | undefined,
): HubServer | undefined => {
  if (!isRecord(value) || name === "") return undefined;
  const type = typeof value["type"] === "string" ? value["type"] : undefined;
  const url = typeof value["url"] === "string" ? value["url"] : undefined;
  const command = typeof value["command"] === "string" ? value["command"] : undefined;
  const transport: HubTransport | undefined =
    type === "sse"
      ? "sse"
      : type === "http" || (type === undefined && url !== undefined)
        ? "http"
        : command !== undefined
          ? "stdio"
          : undefined;
  if (transport === undefined) return undefined;
  const args = Array.isArray(value["args"])
    ? value["args"].filter((arg) => typeof arg === "string")
    : undefined;
  return {
    name,
    scope,
    transport,
    ...(transport === "stdio" && command !== undefined ? { command } : {}),
    ...(transport === "stdio" && args !== undefined ? { args } : {}),
    ...(transport !== "stdio" && url !== undefined ? { url } : {}),
    env: secretsOf(value["env"]),
    headers: secretsOf(value["headers"]),
    enabled: true,
    disabledTools: [],
    ...(file !== undefined ? { file } : {}),
  };
};

/** A copied server in the `mcpServers` format, its secrets left empty. */
export const toMcpJson = (server: PortableServer): Record<string, unknown> =>
  server.transport === "stdio"
    ? {
        type: "stdio",
        command: server.command ?? "",
        args: server.args ?? [],
        ...(server.env.length > 0 ? { env: blanks(server.env) } : {}),
      }
    : {
        type: server.transport,
        url: server.url ?? "",
        ...(server.headers.length > 0 ? { headers: blanks(server.headers) } : {}),
      };

/** `toMcpJson` for formats that spell the blanks out themselves. */
export const blankValues = blanks;

// ---------------------------------------------------------------------------------------------
// Skill folders

/** The `name` and `description` of a `SKILL.md`'s front matter. */
export const skillFrontMatter = (text: string): { readonly name?: string; readonly description?: string } => {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  const field = (key: string): string | undefined => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index === -1) return undefined;
    let value = (lines[index] ?? "").slice(key.length + 1).trim();
    // A folded or literal block (`>`, `|`) continues on the indented lines under it.
    if (/^[>|][-+]?$/.test(value)) {
      const block: Array<string> = [];
      for (const line of lines.slice(index + 1)) {
        if (!/^\s/.test(line) && line.trim() !== "") break;
        block.push(line.trim());
      }
      value = block.join(" ").trim();
    }
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    return value === "" ? undefined : value;
  };
  const name = field("name");
  const description = field("description");
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
};

/**
 * The skills in `folder`: each subfolder holding a `SKILL.md`, named by its front matter or else by
 * the subfolder. A folder that isn't there holds none.
 */
export const readSkillFolders = Effect.fn("Hub.readSkillFolders")(function* (
  folder: string,
  scope: HubScope,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): Array<string> => []));
  const skills = yield* Effect.forEach(entries, (entry) =>
    fs.readFileString(path.join(folder, entry, "SKILL.md")).pipe(
      Effect.map((text): ReadonlyArray<HubSkill> => {
        const { name, description } = skillFrontMatter(text);
        return [
          {
            name: name ?? entry,
            ...(description ? { description } : {}),
            scope,
            path: path.join(folder, entry),
            enabled: true,
          },
        ];
      }),
      Effect.orElseSucceed((): ReadonlyArray<HubSkill> => []),
    ),
  );
  return skills.flat().sort((a, b) => a.name.localeCompare(b.name));
});

/** Reads a JSON or JSONC file; a missing or unreadable file reads as empty text. */
export const readText = Effect.fn("Hub.readText")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
});

/**
 * Rewrites a config file through `edit`, which gets its text ("" when missing), in a temporary file
 * renamed over it so a reader never sees half of it.
 */
export const rewriteFile = Effect.fn("Hub.rewriteFile")(function* (
  file: string,
  edit: (text: string) => string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const before = yield* readText(file);
  const after = edit(before);
  if (after === before) return;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const scratch = `${file}.cerium-${process.pid}.tmp`;
  yield* fs.writeFileString(scratch, after);
  yield* fs.rename(scratch, file);
});
