import { Atom } from "effect/reactivity";

import { Backend, connectionAtom } from "./client.ts";

/**
 * The driven machine's subscribed harnesses and their usage meters. Kept a minute after Settings →
 * Usage closes, so moving between categories doesn't ask the harnesses again; refreshing does.
 */
export const usageAtom = Backend.runtime
  .atom((get) => {
    get(connectionAtom);
    return Backend.use((client) => client("SubscriptionUsage", undefined));
  })
  .pipe(Atom.setIdleTTL("1 minute"));
