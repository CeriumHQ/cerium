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
