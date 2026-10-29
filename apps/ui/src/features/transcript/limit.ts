import { providerName } from "../threads/model.ts";
import type { TranscriptBlock } from "./model.ts";

type LimitBlock = Extract<TranscriptBlock, { kind: "limit" }>;

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** A time as the pause's line says it: "14:00" today, "Thu 14:00" another day. */
export const resumeTime = (at: number, now: number): string => {
  const today = new Date(now);
  const day = new Date(at);
  const sameDay =
    today.getFullYear() === day.getFullYear() &&
    today.getMonth() === day.getMonth() &&
    today.getDate() === day.getDate();
  return (sameDay ? clock : dayClock).format(at);
};

/** Which limit ran out, as the line names it: "Claude 5-hour limit reached". */
export const limitName = (block: Pick<LimitBlock, "provider" | "window">): string =>
  `${providerName[block.provider]} ${block.window ? `${block.window} limit` : "usage limit"} reached`;

/** What became of the limit, after its name: where the thread waits until, or that it went on. */
export const limitOutcome = (block: LimitBlock, now: number): string | undefined => {
  switch (block.state) {
    case "reached":
      return undefined;
    case "paused":
      return block.until === undefined
        ? "paused"
        : block.reported === false
          ? `trying again at ${resumeTime(block.until, now)}`
          : `paused until ${resumeTime(block.until, now)}`;
    case "resumed":
      return block.by === "message"
        ? "went on with your message"
        : block.by === "stopped"
          ? "stopped"
          : "resumed";
  }
};
