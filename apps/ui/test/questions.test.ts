import type { Question } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  answerLine,
  coldFor,
  isAnswered,
  optionName,
  pick,
  toResponse,
  write,
} from "../src/features/questions/model.ts";

const one: Question = {
  question: "Which database?",
  options: [{ label: "SQLite (Recommended)" }, { label: "Redis" }],
  multiSelect: false,
  allowOther: true,
};
const several: Question = { ...one, question: "Which checks?", multiSelect: true };
const empty = { choices: [], text: "" };

describe("answering a question", () => {
  it("lets one choice replace another, or the user's own words", () => {
    const picked = pick(one, { choices: [], text: "Postgres" }, "Redis");
    expect(picked).toEqual({ choices: ["Redis"], text: "" });
    expect(pick(one, picked, "SQLite (Recommended)")).toEqual({
      choices: ["SQLite (Recommended)"],
      text: "",
    });
    expect(write(one, picked, "Postgres")).toEqual({ choices: [], text: "Postgres" });
    // Clearing the words leaves nothing picked in their place.
    expect(write(one, { choices: [], text: "P" }, "")).toEqual({ choices: [], text: "" });
  });

  it("toggles choices of a question that takes several, in the order offered, beside the user's words", () => {
    const both = pick(several, pick(several, empty, "Redis"), "SQLite (Recommended)");
    expect(both.choices).toEqual(["SQLite (Recommended)", "Redis"]);
    expect(pick(several, both, "Redis").choices).toEqual(["SQLite (Recommended)"]);
    expect(write(several, both, "and lint")).toEqual({ choices: both.choices, text: "and lint" });
  });

  it("counts words as an answer only where the question takes them", () => {
    expect(isAnswered(one, empty)).toBe(false);
    expect(isAnswered(one, { choices: [], text: "  " })).toBe(false);
    expect(isAnswered(one, { choices: [], text: "Postgres" })).toBe(true);
    expect(isAnswered({ ...one, allowOther: false }, { choices: [], text: "Postgres" })).toBe(false);
  });

  it("sends the user's words trimmed, and none where they wrote none", () => {
    expect(
      toResponse([
        { choices: ["Redis"], text: "" },
        { choices: [], text: " Postgres " },
      ]),
    ).toEqual({ outcome: "answered", answers: [{ choices: ["Redis"] }, { choices: [], text: "Postgres" }] });
  });
});

describe("optionName", () => {
  it("takes the agent's recommendation out of the label", () => {
    expect(optionName("SQLite (Recommended)")).toEqual({ name: "SQLite", recommended: true });
    expect(optionName("Redis")).toEqual({ name: "Redis", recommended: false });
    expect(optionName("(Recommended)")).toEqual({ name: "(Recommended)", recommended: false });
  });
});

describe("answerLine", () => {
  it("names the choices without the recommendation, then the user's words", () => {
    expect(answerLine({ choices: ["SQLite (Recommended)", "Redis"], text: "both" })).toBe(
      "SQLite, Redis, both",
    );
  });
});

describe("coldFor", () => {
  const hour = 60 * 60_000;
  it("says nothing while the agent's cache is likely still warm", () => {
    expect(coldFor(0, 59 * 60_000)).toBeUndefined();
  });

  it("says how long the agent has waited once it has likely gone cold", () => {
    expect(coldFor(0, hour)).toBe("1h");
    expect(coldFor(0, 8.5 * hour)).toBe("8h");
    expect(coldFor(0, 50 * hour)).toBe("2d");
  });
});
