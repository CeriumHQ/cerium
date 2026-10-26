import { describe, expect, it } from "@effect/vitest";

import { jumpCandidates, matchedWords, passageTexts } from "../src/features/transcript/find.ts";

const passage = [
  { text: "…the ", match: false },
  { text: "data", match: true },
  { text: " model", match: false },
  { text: " and the ", match: false },
  { text: "data", match: true },
  { text: "…", match: false },
];

describe("passageTexts", () => {
  it("cuts the passage where the search cut it, leaving out the ellipses", () => {
    expect(passageTexts(passage)).toEqual(["the data model and the data"]);
  });

  it("splits on an ellipsis inside the passage, so each part must be found on its own", () => {
    expect(passageTexts([{ text: "first part… second", match: false }])).toEqual(["first part", "second"]);
  });

  it("has nothing to look for in a passage of only ellipses", () => {
    expect(passageTexts([{ text: "…", match: false }])).toEqual([]);
  });
});

describe("matchedWords", () => {
  it("lists each matched word once, in the order the passage gives them", () => {
    expect(matchedWords(passage)).toEqual(["data"]);
  });
});

describe("jumpCandidates", () => {
  const messages = [
    { id: "a", text: "The data model is ready" },
    { id: "b", text: "the data model, again" },
    { id: "c", text: "nothing here" },
  ];
  const short = [
    { text: "the ", match: false },
    { text: "data", match: true },
    { text: " model", match: false },
  ];

  it("ranks the newest message holding the passage first, then the newest sharing its words", () => {
    expect(jumpCandidates(messages, short)).toEqual(["b", "a"]);
  });

  it("offers no message that shares none of the words", () => {
    expect(jumpCandidates([{ id: "c", text: "nothing here" }], short)).toEqual([]);
  });

  it("offers only messages holding the passage when no word was matched", () => {
    const plain = [
      { text: "the ", match: false },
      { text: "data model", match: false },
    ];
    expect(jumpCandidates(messages, plain)).toEqual(["b"]);
  });
});
