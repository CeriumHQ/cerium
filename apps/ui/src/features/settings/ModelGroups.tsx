import type { ProviderId } from "@cerium/protocol";

import type { HarnessIndicator } from "../threads/Sidebar.tsx";

/** The providers whose harness can run right now. */
export const readyProviders = (harnesses: ReadonlyArray<HarnessIndicator>): ReadonlySet<ProviderId> =>
  new Set(harnesses.flatMap(({ provider, state }) => (state === "ready" ? [provider] : [])));
