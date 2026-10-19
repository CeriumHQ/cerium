import type { Question, QuestionAnswer, QuestionResponse } from "@cerium/protocol";

// What the user has picked and written for each question of a card, before they send it.

/** The answer to one question as the user gives it: the options picked and their own words. */
export interface Draft {
  readonly choices: ReadonlyArray<string>;
  readonly text: string;
}

export const emptyDrafts = (questions: ReadonlyArray<Question>): ReadonlyArray<Draft> =>
  questions.map(() => ({ choices: [], text: "" }));

/** Whether the question has an answer to send: an option picked, or words where it takes them. */
export const isAnswered = (question: Question, draft: Draft): boolean =>
  draft.choices.length > 0 || (question.allowOther && draft.text.trim() !== "");

/**
 * Picks an option, or for a question of several choices, toggles it. One choice stands alone, so it
 * replaces the user's own words; those words are their other answer.
 */
export const pick = (question: Question, draft: Draft, label: string): Draft =>
  question.multiSelect
    ? {
        ...draft,
        choices: draft.choices.includes(label)
          ? draft.choices.filter((choice) => choice !== label)
          : // In the order the agent offered them.
            question.options.flatMap((option) =>
              option.label === label || draft.choices.includes(option.label) ? [option.label] : [],
            ),
      }
    : { choices: [label], text: "" };

/** The user's own words; for a question of one choice they stand instead of the option picked. */
export const write = (question: Question, draft: Draft, text: string): Draft =>
  question.multiSelect || text.trim() === "" ? { ...draft, text } : { choices: [], text };

export const toResponse = (drafts: ReadonlyArray<Draft>): QuestionResponse => ({
  outcome: "answered",
  answers: drafts.map(({ choices, text }): QuestionAnswer => {
    const words = text.trim();
    return words === "" ? { choices } : { choices, text: words };
  }),
});

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** An option's label without the "(Recommended)" agents mark their pick with, and whether it had one. */
export const optionName = (label: string): { readonly name: string; readonly recommended: boolean } => {
  const name = label.replace(RECOMMENDED, "");
  return name === "" ? { name: label, recommended: false } : { name, recommended: name !== label };
};

/** What the user answered, in a line: the options picked by name, then their own words. */
export const answerLine = (answer: QuestionAnswer | undefined): string =>
  answer === undefined
    ? ""
    : [
        ...answer.choices.map((choice) => optionName(choice).name),
        ...(answer.text ? [answer.text] : []),
      ].join(", ");
