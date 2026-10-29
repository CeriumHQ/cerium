// `/btw <question>` in the message box asks a side question instead of sending a message.

/**
 * The question a draft asks as a side question: what follows `/btw`, which is empty for a bare
 * `/btw`. Undefined when the draft isn't one, such as `/btwfoo` or a message that mentions it.
 */
export const sideQuestionOf = (text: string): string | undefined => {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text);
  return match === null ? undefined : (match[1] ?? "").trim();
};
