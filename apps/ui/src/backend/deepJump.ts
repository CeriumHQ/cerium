import { compareHistory, type AgentEvent, type HistoryCursor, type HistoryPage } from "@cerium/protocol";
import { Data, Effect } from "effect";

import type { ThreadLog } from "./threadLog.ts";

/** The target of a jump isn't in the thread's history any more (rewound away, or never synced). */
export class JumpMissing extends Data.TaggedError("JumpMissing")<{ readonly id: string }> {}

/** One `ThreadHistory` page request older than `before`; `state` leaves out tool and reasoning payloads. */
export type ReadHistory<E> = (request: {
  readonly before: HistoryCursor;
  readonly state?: boolean;
}) => Effect.Effect<HistoryPage, E>;

/**
 * A stretch of the loaded history that holds only state events (messages, inputs, rewinds, turn ends):
 * everything from `older` up to, not including, `newer`. Its tool calls haven't been read.
 */
export interface Gap {
  readonly older: HistoryCursor;
  readonly newer: HistoryCursor;
}

const cursor = ({ at, sequence, id }: AgentEvent | HistoryCursor): HistoryCursor => ({
  at,
  sequence,
  id,
});

/**
 * Brings `target` into the loaded history of `log`, whose oldest event is `newest`, without reading
 * the tool payloads of the stretch in between: the state events from there back to the target are
 * read first (they keep rewinds and turn boundaries right), then one full page ending just after the
 * target, so its own turn keeps its tool calls. Nothing is added to the log unless every read worked.
 * The result says where the loaded history now ends, and which stretch has state events only.
 */
export const jumpThrough = <E>(
  read: ReadHistory<E>,
  log: ThreadLog,
  target: HistoryCursor,
  newest: HistoryCursor,
): Effect.Effect<
  { readonly gap: Gap; readonly before: HistoryCursor | undefined; readonly more: boolean },
  E | JumpMissing
> =>
  Effect.gen(function* () {
    const pages: Array<ReadonlyArray<AgentEvent>> = [];
    let before = newest;
    let successor = newest;
    for (;;) {
      const page = yield* read({ before, state: true });
      const following = pages.at(-1)?.[0];
      pages.push(page.events);
      const at = page.events.findIndex((event) => event.id === target.id);
      if (at >= 0) {
        successor = cursor(page.events[at + 1] ?? following ?? newest);
        break;
      }
      if (!page.more || !page.before || compareHistory(page.before, target) < 0)
        return yield* new JumpMissing({ id: target.id });
      before = page.before;
      yield* Effect.yieldNow;
    }
    const sparse = pages.reverse().flat();
    let window = yield* read({ before: successor });
    // One long tool run can span several pages between consecutive state events.
    if (window.before && compareHistory(window.before, target) > 0) {
      successor = target;
      window = yield* read({ before: target });
    }
    // State events older than the full page's first are left for the ordinary older pages.
    const kept =
      window.before === undefined
        ? sparse
        : sparse.filter((each) => compareHistory(each, window.before!) >= 0);
    log.add(kept);
    log.add(window.events);
    const first = window.before ?? (kept[0] === undefined ? undefined : cursor(kept[0]));
    return { gap: { older: successor, newer: newest }, before: first, more: window.more };
  });

/** Reads the tool calls of `gap` as ordinary full pages, newest first, and stops at its older end. */
export const fillGap = <E>(read: ReadHistory<E>, log: ThreadLog, gap: Gap): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    let before = gap.newer;
    while (compareHistory(before, gap.older) > 0) {
      const page = yield* read({ before });
      log.add(page.events.filter((event) => compareHistory(event, gap.older) >= 0));
      if (!page.more || page.before === undefined) return;
      before = page.before;
      yield* Effect.yieldNow;
    }
  });
