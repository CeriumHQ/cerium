import { describe, expect, it } from "@effect/vitest";

import { textMenuGroups } from "../src/app/textMenuGroups.ts";
import type { TextMenuRequest } from "../src/backend/shell.ts";

const nothing: TextMenuRequest = {
  x: 10,
  y: 20,
  editable: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false,
  selection: false,
};

const labels = (request: TextMenuRequest) =>
  textMenuGroups(request).map((group) => group.map((entry) => entry.label));

describe("textMenuGroups", () => {
  it("offers nothing on empty space, a button or a plain image", () => {
    expect(textMenuGroups(nothing)).toEqual([]);
  });

  it("offers editing in a field, disabled where the field can't", () => {
    const groups = textMenuGroups({ ...nothing, editable: true, canPaste: true, canSelectAll: true });
    expect(groups).toEqual([
      [
        { command: { kind: "cut" }, label: "Cut", disabled: true },
        { command: { kind: "copy" }, label: "Copy", disabled: true },
        { command: { kind: "paste" }, label: "Paste", disabled: false },
        { command: { kind: "selectAll" }, label: "Select all", disabled: false },
      ],
    ]);
  });

  it("puts spelling suggestions first, each replacing the word by its index", () => {
    const groups = textMenuGroups({
      ...nothing,
      editable: true,
      misspelling: { word: "teh", suggestions: ["the", "ten"] },
    });
    expect(groups[0]).toEqual([
      { command: { kind: "replaceMisspelling", suggestion: 0 }, label: "the" },
      { command: { kind: "replaceMisspelling", suggestion: 1 }, label: "ten" },
      { command: { kind: "addToDictionary" }, label: "Add to dictionary" },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("offers adding a word without suggestions to the dictionary", () => {
    expect(
      labels({ ...nothing, editable: true, misspelling: { word: "cerium", suggestions: [] } })[0],
    ).toEqual(["Add to dictionary"]);
  });

  it("copies selected read-only text", () => {
    expect(textMenuGroups({ ...nothing, selection: true, canCopy: true })).toEqual([
      [{ command: { kind: "copySelection" }, label: "Copy" }],
    ]);
  });

  it("opens https links and only copies others", () => {
    expect(labels({ ...nothing, link: { openable: true } })).toEqual([["Open link", "Copy link address"]]);
    expect(labels({ ...nothing, link: { openable: false } })).toEqual([["Copy link address"]]);
  });

  it("puts the link after the selected text", () => {
    expect(labels({ ...nothing, selection: true, link: { openable: true } })).toEqual([
      ["Copy"],
      ["Open link", "Copy link address"],
    ]);
  });
});
