/** Calendar months use the agent machine's local timezone, as the router's spend always has. */
export const effortSpend = (
  costs: ReadonlyArray<{ readonly at: number; readonly costUsd: number }>,
  now: number,
) => {
  const date = new Date(now);
  const monthStartsAt = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const monthEndsAt = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
  let monthUsd = 0;
  let totalUsd = 0;
  for (const cost of costs) {
    totalUsd += cost.costUsd;
    if (cost.at >= monthStartsAt && cost.at < monthEndsAt && cost.at <= now) monthUsd += cost.costUsd;
  }
  const elapsed = now - monthStartsAt;
  return {
    monthUsd,
    totalUsd,
    monthEndsAt,
    projectedMonthUsd: elapsed > 0 ? monthUsd * ((monthEndsAt - monthStartsAt) / elapsed) : 0,
  };
};
