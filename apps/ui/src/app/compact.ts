import { useSyncExternalStore } from "react";

// Below 768 px wide the window is one column, showing one thing at a time (docs/architecture.md
// §14.10): the inbox, a thread or settings. It matches Tailwind's `md` breakpoint, which the
// components' own spacing switches on. The desktop's window never gets this narrow.

const query = "(max-width: 767.98px)";

const subscribe = (onChange: () => void) => {
  const list = matchMedia(query);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};

/** Whether the window is phone-narrow. */
export const useCompact = () => useSyncExternalStore(subscribe, () => matchMedia(query).matches);
