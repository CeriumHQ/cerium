import { describe, expect, it } from "@effect/vitest";

import { highlightLines, languageOf, tokenize, type Token } from "../src/features/files/highlight.ts";

/** Tokens as `kind:text` for what isn't plain, so a test reads like the file. */
const marked = (tokens: ReadonlyArray<Token>) =>
  tokens.filter((token) => token.kind !== "plain").map((token) => `${token.kind}:${token.text}`);

describe("languageOf", () => {
  it("knows files by extension and by name, whatever the case", () => {
    expect(languageOf("src/App.tsx")).toBe("js");
    expect(languageOf("C:\\code\\Cargo.toml")).toBe("toml");
    expect(languageOf("lib/main.RS")).toBe("rust");
    expect(languageOf("Dockerfile")).toBe("shell");
    expect(languageOf(".env.local")).toBe("toml");
    expect(languageOf("README.md")).toBe("markdown");
    expect(languageOf("notes.txt")).toBeUndefined();
    expect(languageOf("LICENSE")).toBeUndefined();
  });
});

describe("tokenize", () => {
  it("leaves text of no known language whole", () => {
    expect(tokenize("a b\nc", undefined)).toEqual([{ kind: "plain", text: "a b\nc" }]);
  });

  it("tells keywords, types, strings, numbers and comments apart in TypeScript", () => {
    const tokens = tokenize(`export const user: User = { name: "Ada", age: 36 }; // hi\n`, "js");
    expect(marked(tokens)).toEqual([
      "keyword:export",
      "keyword:const",
      "type:User",
      'string:"Ada"',
      "number:36",
      "comment:// hi",
    ]);
  });

  it("joins every token back into the text it came from", () => {
    const text = "const a = `x\n${1 + 2}`; /* c\n d */ let b = 'it\\'s';\n";
    expect(
      tokenize(text, "js")
        .map((token) => token.text)
        .join(""),
    ).toBe(text);
  });

  it("reads a template literal and a block comment across lines as one token each", () => {
    const tokens = tokenize("const s = `a\nb`;\n/* one\ntwo */\n", "js");
    expect(marked(tokens)).toEqual(["keyword:const", "string:`a\nb`", "comment:/* one\ntwo */"]);
  });

  it("ends a string that never closes at the end of its line", () => {
    const tokens = tokenize("const a = 'oops\nconst b = 1\n", "js");
    expect(marked(tokens)).toEqual(["keyword:const", "string:'oops", "keyword:const", "number:1"]);
  });

  it("takes a JSON string before a colon as a key", () => {
    expect(marked(tokenize('{ "a": "b", "n": [1, 2.5, true, null] }', "json"))).toEqual([
      'key:"a"',
      'string:"b"',
      'key:"n"',
      "number:1",
      "number:2.5",
      "keyword:true",
      "keyword:null",
    ]);
  });

  it("reads hash comments only after whitespace in a shell and YAML", () => {
    expect(marked(tokenize("echo $# a#b # real\n", "shell"))).toEqual(["keyword:echo", "comment:# real"]);
    expect(marked(tokenize("name: app # note\nitems:\n  - id: 1\n", "yaml"))).toEqual([
      "key:name",
      "comment:# note",
      "key:items",
      "key:id",
      "number:1",
    ]);
  });

  it("reads TOML sections, keys and strings", () => {
    expect(marked(tokenize('[package]\nname = "cerium"\nedition = 2021\n', "toml"))).toEqual([
      "type:[package]",
      "key:name",
      'string:"cerium"',
      "key:edition",
      "number:2021",
    ]);
  });

  it("reads Python's keywords, triple-quoted strings and comments", () => {
    const tokens = tokenize('def f(self):\n    """Doc\n    string"""\n    return None  # done\n', "python");
    expect(marked(tokens)).toEqual([
      "keyword:def",
      "keyword:self",
      'string:"""Doc\n    string"""',
      "keyword:return",
      "keyword:None",
      "comment:# done",
    ]);
  });

  it("doesn't take a Rust lifetime for a string", () => {
    expect(marked(tokenize("fn f<'a>(x: &'a str) -> char { 'z' }\n", "rust"))).toEqual([
      "keyword:fn",
      "keyword:char",
      "string:'z'",
    ]);
  });

  it("ignores the case of SQL's keywords", () => {
    expect(marked(tokenize("Select name FROM users -- all\n", "sql"))).toEqual([
      "keyword:Select",
      "keyword:FROM",
      "comment:-- all",
    ]);
  });

  it("reads tags, attributes and strings in markup, and comments", () => {
    expect(marked(tokenize('<div class="a" hidden>text</div><!-- c -->', "markup"))).toEqual([
      "tag:<div",
      "attr:class",
      'string:"a"',
      "attr:hidden",
      "tag:</div",
      "comment:<!-- c -->",
    ]);
  });

  it("tells CSS properties from selectors, and reads at-rules and colours", () => {
    const css = "@media (min-width: 40em) {\n  a:hover { color: #fff; margin: 0 4px; }\n}\n";
    expect(marked(tokenize(css, "css"))).toEqual([
      "keyword:@media",
      "number:40em",
      "key:color",
      "number:#fff",
      "key:margin",
      "number:0",
      "number:4px",
    ]);
  });

  it("marks up Markdown's headings, code and quotes", () => {
    const tokens = tokenize("# Title\nSome `code` here\n```ts\nlet x\n```\n> quote\n", "markdown");
    expect(marked(tokens)).toEqual([
      "keyword:# Title\n",
      "string:`code`",
      "comment:```ts\n",
      "string:let x\n",
      "comment:```\n",
      "comment:> quote\n",
    ]);
  });
});

describe("highlightLines", () => {
  it("cuts tokens that span lines at each line, and drops the empty line a final newline leaves", () => {
    const lines = highlightLines("/* a\nb */\nlet x\n", "js");
    expect(lines.map((line) => line.map((token) => token.text).join(""))).toEqual(["/* a", "b */", "let x"]);
    expect(lines[1]).toEqual([{ kind: "comment", text: "b */" }]);
  });

  it("keeps blank lines, and drops carriage returns", () => {
    const lines = highlightLines("a\r\n\r\nb", undefined);
    expect(lines.map((line) => line.map((token) => token.text).join(""))).toEqual(["a", "", "b"]);
  });

  it("gives an empty file no lines worth showing", () => {
    expect(highlightLines("", "js")).toEqual([[]]);
  });
});
