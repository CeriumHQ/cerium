/** The next card for an Inbox navigation key, without wrapping at either end. */
export function inboxNavigationTarget(
  keys: ReadonlyArray<string>,
  focused: string | undefined,
  key: string,
): string | undefined {
  const index = focused === undefined ? -1 : keys.indexOf(focused);
  switch (key.toLowerCase()) {
    case "j":
    case "arrowdown":
      return keys[Math.min(index + 1, keys.length - 1)];
    case "k":
    case "arrowup":
      return keys[index < 0 ? keys.length - 1 : Math.max(0, index - 1)];
    case "home":
      return keys[0];
    case "end":
      return keys.at(-1);
  }
}

/** After triage removes a card, keep focus near its old position. */
export function inboxFocusAfterRemoval(
  before: ReadonlyArray<string>,
  remaining: ReadonlyArray<string>,
  removed: string,
): string | undefined {
  const at = before.indexOf(removed);
  const survives = (key: string) => remaining.includes(key);
  return (
    before.slice(at + 1).find(survives) ?? before.slice(0, Math.max(0, at)).findLast(survives) ?? remaining[0]
  );
}
