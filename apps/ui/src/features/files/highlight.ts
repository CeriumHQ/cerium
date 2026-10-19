// Syntax highlighting for the file preview: a small scanner of Cerium's own that tells comments,
// strings, numbers, keywords, types, keys and markup apart, in the handful of colours the design
// tokens give code. It reads what a person scanning a file needs, not every grammar's corner cases.

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "key"
  | "tag"
  | "attr";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

interface Grammar {
  /** What starts a comment that runs to the end of the line. */
  readonly line?: ReadonlyArray<string>;
  /** A line comment marker only counts after whitespace (`#` in a shell, so `$#` and `a#b` aren't). */
  readonly lineAfterSpace?: boolean;
  readonly block?: readonly [string, string];
  /** The characters that open a string. */
  readonly quotes?: string;
  /** Strings may run across lines (template literals; `"""` in Python). */
  readonly multiline?: string;
  /** `'x'` is a character, not the start of a string (Rust's lifetimes would break one). */
  readonly characters?: boolean;
  readonly keywords?: ReadonlySet<string>;
  readonly ignoreCase?: boolean;
  /** Capitalised names are types. */
  readonly types?: boolean;
  /** A string before a colon is a key (JSON); with `bare`, so is a name that begins a line before `:` or `=`. */
  readonly keys?: "quoted" | "bare";
  readonly markup?: boolean;
  readonly css?: boolean;
}

const words = (list: string) => new Set(list.split(/\s+/).filter((word) => word !== ""));

const jsKeywords = words(`
  break case catch class const continue debugger default delete do else enum export extends false finally for
  function if import in instanceof new null of return super switch this throw true try typeof undefined var void
  while with yield async await let static get set as from type interface implements namespace declare abstract
  readonly private protected public override satisfies keyof infer is asserts module require`);

const cLikeKeywords = words(`
  abstract as async await base bool boolean break byte case catch char checked class const continue crate
  decimal default defer delegate delete do double dyn else enum event explicit export extends extern false
  final finally fixed float fn for foreach fun func function go goto if impl implements import in inline int
  interface internal is lambda let lock long loop match mod move mut namespace native new nil null object
  operator out override package private protected pub public readonly ref return sealed select self short
  signed sizeof static struct super switch synchronized template this throw throws trait true try type typedef
  typeof union unsafe unsigned use using val var virtual void volatile where while yield`);

const pyKeywords = words(`
  and as assert async await break case class continue def del elif else except False finally for from global
  if import in is lambda match None nonlocal not or pass raise return self True try while with yield`);

const shKeywords = words(`
  alias break case cd continue declare do done echo elif else esac eval exec exit export fi for function if in
  local read return set shift source then trap unset until while Write-Host Write-Output param foreach switch
  try catch finally throw begin process end class enum using`);

const sqlKeywords = words(`
  add all alter and as asc between by case check column constraint create cross database default delete desc
  distinct drop else end exists foreign from full group having if in index inner insert into is join key left
  like limit not null on or order outer primary references right select set table then union unique update
  values view when where with`);

const rubyKeywords = words(`
  alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or
  redo rescue retry return self super then true undef unless until when while yield require include extend
  attr_accessor attr_reader attr_writer`);

const phpKeywords = words(`
  abstract and array as break callable case catch class clone const continue declare default do echo else
  elseif empty endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global
  if implements include instanceof interface isset list match namespace new null or print private protected
  public readonly require return static switch throw trait true false try unset use var while yield`);

const jsonKeywords = words("true false null");
const yamlKeywords = words("true false null yes no on off");
const tomlKeywords = words("true false");

const cStyle: Grammar = {
  line: ["//"],
  block: ["/*", "*/"],
  quotes: "\"'`",
  // Go's raw strings.
  multiline: "`",
  keywords: cLikeKeywords,
  types: true,
};

const grammars = {
  js: {
    line: ["//"],
    block: ["/*", "*/"],
    quotes: "\"'`",
    multiline: "`",
    keywords: jsKeywords,
    types: true,
  },
  json: { line: ["//"], block: ["/*", "*/"], quotes: '"', keywords: jsonKeywords, keys: "quoted" },
  css: { block: ["/*", "*/"], quotes: `"'`, css: true },
  markup: { quotes: `"'`, markup: true },
  python: {
    line: ["#"],
    quotes: `"'`,
    multiline: `"'`,
    keywords: pyKeywords,
    types: true,
  },
  rust: {
    line: ["//"],
    block: ["/*", "*/"],
    quotes: '"',
    characters: true,
    keywords: cLikeKeywords,
    types: true,
  },
  c: cStyle,
  shell: { line: ["#"], lineAfterSpace: true, block: ["<#", "#>"], quotes: `"'`, keywords: shKeywords },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: `'"`, keywords: sqlKeywords, ignoreCase: true },
  yaml: { line: ["#"], lineAfterSpace: true, quotes: `"'`, keywords: yamlKeywords, keys: "bare" },
  toml: { line: ["#", ";"], lineAfterSpace: true, quotes: `"'`, keywords: tomlKeywords, keys: "bare" },
  ruby: { line: ["#"], quotes: `"'`, keywords: rubyKeywords, types: true },
  php: { line: ["//", "#"], block: ["/*", "*/"], quotes: `"'`, keywords: phpKeywords, types: true },
  lua: {
    line: ["--"],
    block: ["--[[", "]]"],
    quotes: `"'`,
    keywords: words(
      "and break do else elseif end false for function if in local nil not or repeat return then true until while",
    ),
  },
} satisfies Record<string, Grammar>;

export type Language = keyof typeof grammars | "markdown";

const byExtension: Readonly<Record<string, Language>> = {
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  xaml: "markup",
  csproj: "markup",
  props: "markup",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "c",
  java: "c",
  kt: "c",
  kts: "c",
  cs: "c",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  swift: "c",
  dart: "c",
  scala: "c",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "shell",
  psm1: "shell",
  bat: "shell",
  cmd: "shell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "toml",
  cfg: "toml",
  env: "toml",
  rb: "ruby",
  php: "php",
  lua: "lua",
};

const byName: Readonly<Record<string, Language>> = {
  dockerfile: "shell",
  makefile: "shell",
  ".gitignore": "shell",
  ".gitattributes": "shell",
  ".editorconfig": "toml",
  ".env": "toml",
};

/** The language a file name suggests, or none: its text is shown plain. */
export const languageOf = (path: string): Language | undefined => {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  const byFile = byName[name];
  if (byFile !== undefined) return byFile;
  if (name.startsWith(".env")) return "toml";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : byExtension[name.slice(dot + 1)];
};

const identifier = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const bareKey = /[\w.-]+/y;
const number =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)(?:[a-zA-Z%]{0,3})/y;
const hexColor = /#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{3,4})\b/y;
const character = /'(?:\\.[^'\n]*|[^'\\\n])'/y;
const tagStart = /<\/?[A-Za-z][\w:.-]*/y;
const attributeName = /[\w:@.#-]+/y;
const cssName = /-{0,2}[A-Za-z_][\w-]*/y;

const match = (pattern: RegExp, text: string, at: number): string | undefined => {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
};

/** The index just past the string that opens at `at`, its closing quote included when it has one. */
const stringEnd = (text: string, at: number, quote: string, multiline: boolean): number => {
  for (let index = at + 1; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === quote) return index + 1;
    else if (char === "\n" && !multiline) return index;
  }
  return text.length;
};

const lineEnd = (text: string, at: number) => {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
};

/** Whether the first thing on its line (after indentation and a list dash) starts at `at`. */
const startsLine = (text: string, at: number): boolean => {
  const from = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*(?:- )*$/.test(text.slice(from, at));
};

/** Cuts `text` into tokens, joining what runs together. A token may span lines. */
export const tokenize = (text: string, language: Language | undefined): ReadonlyArray<Token> => {
  if (language === undefined) return [{ kind: "plain", text }];
  if (language === "markdown") return markdownTokens(text);
  const grammar: Grammar = grammars[language];
  const tokens: Array<Token> = [];
  let plainFrom = 0;
  let braces = 0;
  const emit = (kind: TokenKind, from: number, to: number) => {
    if (from > plainFrom) tokens.push({ kind: "plain", text: text.slice(plainFrom, from) });
    tokens.push({ kind, text: text.slice(from, to) });
    plainFrom = to;
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at]!;

    if (grammar.markup === true) {
      if (text.startsWith("<!--", at)) {
        const close = text.indexOf("-->", at + 4);
        const end = close < 0 ? text.length : close + 3;
        emit("comment", at, end);
        at = end;
        continue;
      }
      const tag = char === "<" ? match(tagStart, text, at) : undefined;
      if (tag !== undefined) {
        emit("tag", at, at + tag.length);
        at += tag.length;
        // The tag's attributes, up to where it closes.
        while (at < text.length && text[at] !== ">") {
          const here = text[at]!;
          if (here === '"' || here === "'") {
            const end = stringEnd(text, at, here, true);
            emit("string", at, end);
            at = end;
            continue;
          }
          const name = match(attributeName, text, at);
          if (name !== undefined) {
            emit("attr", at, at + name.length);
            at += name.length;
            continue;
          }
          at++;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        // Text outside a tag isn't a string.
        at++;
        continue;
      }
      at++;
      continue;
    }

    if (grammar.block !== undefined && text.startsWith(grammar.block[0], at)) {
      const close = text.indexOf(grammar.block[1], at + grammar.block[0].length);
      const end = close < 0 ? text.length : close + grammar.block[1].length;
      emit("comment", at, end);
      at = end;
      continue;
    }

    const marker = grammar.line?.find((each) => text.startsWith(each, at));
    if (marker !== undefined && (grammar.lineAfterSpace !== true || at === 0 || /\s/.test(text[at - 1]!))) {
      const end = lineEnd(text, at);
      emit("comment", at, end);
      at = end;
      continue;
    }

    if (grammar.css === true && char === "#") {
      const color = match(hexColor, text, at);
      if (color !== undefined) {
        emit("number", at, at + color.length);
        at += color.length;
        continue;
      }
    }

    if (grammar.characters === true && char === "'") {
      // A character; anything else the quote starts, such as a lifetime, is left alone.
      const literal = match(character, text, at);
      if (literal !== undefined) {
        emit("string", at, at + literal.length);
        at += literal.length;
      } else {
        at++;
      }
      continue;
    }

    if (grammar.quotes?.includes(char) === true) {
      const triple = char.repeat(3);
      const multiline =
        grammar.multiline?.includes(char) === true && (char === "`" || text.startsWith(triple, at));
      let end: number;
      if (multiline && char !== "`") {
        const close = text.indexOf(triple, at + 3);
        end = close < 0 ? text.length : close + 3;
      } else {
        end = stringEnd(text, at, char, multiline);
      }
      const after = /^[ \t]*:/.exec(text.slice(end, end + 24));
      emit(grammar.keys === "quoted" && after !== null ? "key" : "string", at, end);
      at = end;
      continue;
    }

    if (grammar.keys === "bare" && startsLine(text, at)) {
      if (char === "[") {
        // A TOML or INI section.
        const section = /^\[+[^\]\n]*\]+/.exec(text.slice(at, lineEnd(text, at)));
        if (section !== null) {
          emit("type", at, at + section[0].length);
          at += section[0].length;
          continue;
        }
      }
      const name = match(bareKey, text, at);
      if (
        name !== undefined &&
        /^[ \t]*[:=](?:\s|$)/.test(text.slice(at + name.length, at + name.length + 8))
      ) {
        emit("key", at, at + name.length);
        at += name.length;
        continue;
      }
    }

    if (/\d/.test(char) || (char === "." && /\d/.test(text[at + 1] ?? ""))) {
      const value = match(number, text, at);
      if (value !== undefined && value !== "") {
        emit("number", at, at + value.length);
        at += value.length;
        continue;
      }
    }

    if (grammar.css === true) {
      if (char === "{") braces++;
      else if (char === "}") braces = Math.max(0, braces - 1);
      if (char === "@") {
        const name = match(cssName, text, at + 1);
        if (name !== undefined) {
          emit("keyword", at, at + 1 + name.length);
          at += 1 + name.length;
          continue;
        }
      }
      const name = match(cssName, text, at);
      if (name !== undefined) {
        // `name:` is a property when what follows ends in `;` or `}`, a selector (`a:hover`) when in `{`.
        const after = text.slice(at + name.length, at + name.length + 200);
        const declaration = braces > 0 && /^\s*:(?!:)/.test(after) && !/^[^{;}]*\{/.test(after);
        if (declaration) emit("key", at, at + name.length);
        at += name.length;
        continue;
      }
      at++;
      continue;
    }

    const word = match(identifier, text, at);
    if (word !== undefined) {
      const lookup = grammar.ignoreCase === true ? word.toLowerCase() : word;
      if (grammar.keywords?.has(lookup) === true) emit("keyword", at, at + word.length);
      else if (grammar.types === true && /^[A-Z][\w$]*[a-z][\w$]*$/.test(word))
        emit("type", at, at + word.length);
      at += word.length;
      continue;
    }

    at++;
  }
  if (plainFrom < text.length) tokens.push({ kind: "plain", text: text.slice(plainFrom) });
  return tokens;
};

/** Markdown's source: headings, quotes, code and fences stand out; the prose stays plain. */
const markdownTokens = (text: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = [];
  let fenced = false;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const eol = index < lines.length - 1 ? "\n" : "";
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      tokens.push({ kind: "comment", text: line + eol });
    } else if (fenced) {
      tokens.push({ kind: "string", text: line + eol });
    } else if (/^#{1,6}\s/.test(line)) {
      tokens.push({ kind: "keyword", text: line + eol });
    } else if (/^\s*>/.test(line)) {
      tokens.push({ kind: "comment", text: line + eol });
    } else {
      // `code` spans inside a line.
      const parts = line.split(/(`[^`\n]+`)/);
      parts.forEach((part, at) => {
        if (part !== "") tokens.push({ kind: at % 2 === 1 ? "string" : "plain", text: part });
      });
      if (eol !== "") tokens.push({ kind: "plain", text: eol });
    }
  });
  return tokens;
};

/** Tokens regrouped into lines, the tokens that span lines cut at each one. */
export const toLines = (tokens: ReadonlyArray<Token>): ReadonlyArray<ReadonlyArray<Token>> => {
  const lines: Array<Array<Token>> = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      const clean = part.replace(/\r$/, "");
      if (clean !== "") lines.at(-1)!.push({ kind: token.kind, text: clean });
    });
  }
  return lines;
};

/** A file's lines as tokens. A trailing newline doesn't add an empty last line. */
export const highlightLines = (
  text: string,
  language: Language | undefined,
): ReadonlyArray<ReadonlyArray<Token>> => {
  const lines = toLines(tokenize(text, language));
  return lines.length > 1 && lines.at(-1)!.length === 0 ? lines.slice(0, -1) : lines;
};
