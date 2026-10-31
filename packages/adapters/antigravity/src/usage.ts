import type { SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Option } from "effect";

// UNDOCUMENTED FORMAT. `agy -p /usage` answers without starting a turn (documented in the 1.1.11
// changelog), but what it prints isn't documented. Prior art reads one meter per line, tab-separated:
// `<group>\t<metric>\t<remaining %>\t<reset time>`. This parser takes those rows and ignores the rest,
// covered by test/usage.test.ts; an answer it can't read yields no meters rather than wrong ones.

const percent = (text: string | undefined) => {
  const match = /(-?\d+(?:\.\d+)?)\s*%?/.exec(text ?? "");
  return match === null ? undefined : Number(match[1]);
};

/** `/usage` output as Cerium's meters; none when no row reads as one. */
export const parseUsage = (output: string): Option.Option<SubscriptionReport> => {
  const meters: Array<UsageMeter> = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.split("\t").map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const [group = "", metric = "", remaining, reset] = cells;
    const left = percent(remaining);
    if (left === undefined || !/%|^\d/.test(remaining ?? "")) continue;
    const resetsAt = reset === undefined || reset === "" ? Number.NaN : Date.parse(reset);
    const label = [group, metric].filter((part) => part !== "").join(" · ");
    if (label === "") continue;
    meters.push({
      label,
      usedPercent: Math.max(0, 100 - left),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    });
  }
  return meters.length === 0 ? Option.none() : Option.some({ meters });
};
