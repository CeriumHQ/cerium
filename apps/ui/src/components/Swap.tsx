import type { ReactNode } from "react";

import { useChanged } from "../lib/motion.ts";

/**
 * An icon that pops in when another takes its place, such as copy turning into a check; `which`
 * names the one showing. The one it shows first is simply there.
 */
export function Swap({ which, children }: { which: string; children: ReactNode }) {
  const changed = useChanged(which);
  return (
    <span key={which} className={`grid place-items-center ${changed ? "swap-in" : ""}`}>
      {children}
    </span>
  );
}
