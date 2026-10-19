import { answerText, type Question, type QuestionAnswer, type QuestionResponse } from "@cerium/protocol";

// Questions agents put to the user with `ask_user`: what a question and an answer must look like, and
// how the agent is told of the answer.

/**
 * Why the user couldn't answer `questions` as asked, in words for the agent; nothing when they can.
 * Each question needs something to answer with, and its choices must tell apart.
 */
export const questionProblem = (questions: ReadonlyArray<Question>): string | undefined => {
  for (const question of questions) {
    const subject = `"${question.header ?? question.question}"`;
    if (question.options.length === 0 && !question.allowOther) {
      return `${subject} has no options and takes no words: give it options, or let the user answer in their own words.`;
    }
    const labels = question.options.map((option) => option.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) return `${subject} offers the same option twice.`;
  }
  return undefined;
};

/**
 * Why `answers` can't answer `questions`, in words for the user; nothing when they can. One entry per
 * question, each with something in it, from the options offered, and in the user's own words only where
 * the question takes them.
 */
export const answerProblem = (
  questions: ReadonlyArray<Question>,
  answers: ReadonlyArray<QuestionAnswer>,
): string | undefined => {
  if (answers.length !== questions.length) {
    return `The question has ${questions.length} part${questions.length === 1 ? "" : "s"} and the answer ${answers.length}.`;
  }
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]!;
    const text = answer.text?.trim() ?? "";
    const subject = `"${question.header ?? question.question}"`;
    if (answer.choices.length === 0 && text === "") return `Answer ${subject} first.`;
    if (new Set(answer.choices).size !== answer.choices.length) return `${subject} lists a choice twice.`;
    for (const choice of answer.choices) {
      if (!question.options.some((option) => option.label === choice)) {
        return `"${choice}" is not one of the choices for ${subject}.`;
      }
    }
    if (!question.multiSelect && answer.choices.length > 1) return `${subject} takes one choice.`;
    if (text !== "" && !question.allowOther) return `${subject} takes only the choices offered.`;
  }
  return undefined;
};

/** The response as the thread keeps it: the user's words trimmed, and left out where they wrote none. */
export const tidyResponse = (response: QuestionResponse): QuestionResponse =>
  response.outcome === "dismissed"
    ? response
    : {
        outcome: "answered",
        answers: response.answers.map(({ choices, text }) => {
          const words = text?.trim() ?? "";
          return words === "" ? { choices } : { choices, text: words };
        }),
      };

/** The user's response, as the notice an agent that asked through `ask_user` gets. */
export const answerNotice = (questions: ReadonlyArray<Question>, response: QuestionResponse): string => {
  if (response.outcome === "dismissed") {
    return "The user dismissed your question without answering it. Carry on with your best judgment, or put it in your reply if you can't.";
  }
  const lines = questions.map((question, index) => {
    const answer = response.answers[index];
    return `- ${question.question}\n  Answer: ${answer === undefined ? "(none)" : answerText(answer)}`;
  });
  return [`The user answered your question${questions.length === 1 ? "" : "s"}:`, ...lines].join("\n");
};
