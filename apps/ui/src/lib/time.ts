const units: ReadonlyArray<readonly [limit: number, size: number, suffix: string]> = [
  [60, 1, "s"],
  [3_600, 60, "m"],
  [86_400, 3_600, "h"],
  [604_800, 86_400, "d"],
  [Number.POSITIVE_INFINITY, 604_800, "w"],
];

/** Compact relative time for dense lists: "now", "4m", "3h", "2d", "5w". */
export const shortAgo = (timestamp: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "now";
  const [, size, suffix] = units.find(([limit]) => seconds < limit) ?? units[units.length - 1]!;
  return `${Math.floor(seconds / size)}${suffix}`;
};

const MINUTE = 60_000;
const DAY = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** When something happened, as people say it: "just now", "5 minutes ago", "yesterday", "on 12 Oct". */
export const whenAgo = (at: number, now = Date.now()): string => {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < 60 * MINUTE) return relative.format(-Math.floor(elapsed / MINUTE), "minute");
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return relative.format(-Math.floor(elapsed / (60 * MINUTE)), "hour");
  const days = Math.ceil((startOfToday - at) / DAY);
  if (days < 7) return relative.format(-days, "day");
  const date = new Date(at);
  return `on ${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  })}`;
};
