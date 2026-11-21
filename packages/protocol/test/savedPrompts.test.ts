import { describe, expect, it } from "@effect/vitest";

import { expandPromptTemplate, parsePromptTemplate } from "../src/savedPrompts.ts";

describe("saved prompt templates", () => {
  it("expands context when available, including placeholders in a multiline body", () => {
    const template = parsePromptTemplate("Review {{project}}.\nCompare {{branch}} to main.");
    expect(template.parameters).toEqual([]);
    expect(expandPromptTemplate(template, { project: "Cerium", branch: "feature/history" })).toEqual({
      text: "Review Cerium.\nCompare feature/history to main.",
    });
    expect(expandPromptTemplate(template)).toEqual({ text: "Review .\nCompare  to main." });
  });

  it("collects distinct names in order and uses the first explicit default everywhere", () => {
    const template = parsePromptTemplate(
      "{{owner}} reviews {{section:source: ui}}. {{owner:Sam}} and {{owner:Jo}} agree. {{check-list}}",
    );
    expect(template.parameters).toEqual([
      { name: "owner", defaultValue: "Sam" },
      { name: "section", defaultValue: "source: ui" },
      { name: "check-list" },
    ]);
    expect(expandPromptTemplate(template)).toEqual({ text: "Sam reviews source: ui. Sam and Sam agree. " });
    expect(
      expandPromptTemplate(
        template,
        {},
        new Map([
          ["owner", "Lee"],
          ["section", ""],
          ["check-list", "tests"],
        ]),
      ),
    ).toEqual({ text: "Lee reviews . Lee and Lee agree. tests" });
  });

  it("places the cursor by UTF-16 offset after expansion and removes later stops", () => {
    const template = parsePromptTemplate("{{branch}}\n{{name:🙂}}$0! $0");
    expect(expandPromptTemplate(template, { branch: "main" })).toEqual({ text: "main\n🙂! ", cursor: 7 });
    expect(expandPromptTemplate(parsePromptTemplate("$0only"))).toEqual({ text: "only", cursor: 0 });
    expect(expandPromptTemplate(parsePromptTemplate("at end$0"))).toEqual({ text: "at end", cursor: 6 });
  });

  it("treats replacement values as text and handles names that overlap object properties", () => {
    const template = parsePromptTemplate("{{branch}} {{constructor}} {{__proto__:default}} $0");
    expect(
      expandPromptTemplate(template, { branch: "{{project}}" }, new Map([["constructor", "$0"]])),
    ).toEqual({
      text: "{{project}} $0 default ",
      cursor: "{{project}} $0 default ".length,
    });
  });

  it("leaves literal, malformed and escaped tokens untouched", () => {
    const plain = "Keep C:\\work\\tree, {{ unmatched }}, {{missing, $01 and $1";
    expect(expandPromptTemplate(parsePromptTemplate(plain))).toEqual({ text: plain });
    const escaped = parsePromptTemplate("\\{{branch}} \\{{value:10}} \\$0");
    expect(escaped.parameters).toEqual([]);
    expect(expandPromptTemplate(escaped, { branch: "main" })).toEqual({
      text: "{{branch}} {{value:10}} $0",
    });
    expect(expandPromptTemplate(parsePromptTemplate("\\\\{{project}}"), { project: "repo" })).toEqual({
      text: "\\repo",
    });
  });
});
