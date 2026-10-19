import { useSyncExternalStore } from "react";

// A touch screen's main pointer is a finger, and its keyboard has no Shift or Ctrl Enter to tell a
// line break from a send: the message box sends with its button there, and Enter writes a new line.

const query = "(pointer: coarse)";

const subscribe = (onChange: () => void) => {
  const list = matchMedia(query);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};

/** Whether the main pointer is a finger: a phone or tablet, even with a keyboard attached. */
export const useCoarsePointer = () => useSyncExternalStore(subscribe, () => matchMedia(query).matches);
