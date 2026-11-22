import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { Sheet, SheetRow } from "../../components/ui/Sheet.tsx";
import { laterPresets, laterWhen, pickedLater } from "./LaterMenu.tsx";

/**
 * Later's choices as a bottom sheet, for a phone where a submenu is fiddly: the same presets as the
 * menu, each with the time it lands on, then a time of one's own.
 */
export function LaterSheet({
  open,
  onOpenChange,
  onPick,
  onCustom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (until: number) => void;
  onCustom: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Move to Later">
      <LaterOptions onPick={onPick} onCustom={onCustom} />
    </Sheet>
  );
}

/** The sheet's rows, mounted as it opens: the times are reckoned then, and kept while it slides away. */
function LaterOptions({ onPick, onCustom }: { onPick: (until: number) => void; onCustom: () => void }) {
  const [now] = useState(Date.now);
  return (
    <div className="flex flex-col pb-1">
      {laterPresets.map(({ label, until }) => {
        const target = until(now);
        return (
          <SheetRow
            key={label}
            closes
            onClick={() => onPick(pickedLater(until, target, Date.now()))}
            trailing={
              <time dateTime={new Date(target).toISOString()} className="text-[13px] tabular-nums">
                {laterWhen(target, now)}
              </time>
            }
          >
            {label}
          </SheetRow>
        );
      })}
      <div aria-hidden className="mx-3 my-1 h-px shrink-0 bg-line-subtle" />
      <SheetRow closes icon={<CalendarClock size={18} strokeWidth={1.75} />} onClick={onCustom}>
        Custom date and time…
      </SheetRow>
    </div>
  );
}
