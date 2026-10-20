import { Atom } from "effect/reactivity";

import { rangeEdges, type SpendRange } from "../features/settings/spendModel.ts";
import { Backend, connectionAtom } from "./client.ts";

/**
 * What agents used over a range of time on the driven machine, read when the page opens and again on
 * refresh. Kept a minute after Settings → Cost closes, so moving between categories doesn't ask again.
 */
export const spendAtom = Atom.family((range: SpendRange) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return Backend.use((client) => client("SpendReport", { edges: rangeEdges(range, Date.now()) }));
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);
