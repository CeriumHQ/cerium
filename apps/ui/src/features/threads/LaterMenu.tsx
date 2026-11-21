import { CalendarClock } from "lucide-react";
import { useId, useRef, useState } from "react";

import { DialogButton, DialogField, DialogInput, FormDialog } from "../../components/ui/FormDialog.tsx";
import { MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { customLaterTime, laterInHour, laterNextWeek, laterToday, laterTomorrow } from "./model.ts";

const presets = [
  { label: "In an hour", until: laterInHour },
  { label: "Later today", until: laterToday },
  { label: "Tomorrow", until: laterTomorrow },
  { label: "Next week", until: laterNextWeek },
];
const DAY = 86_400_000;
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayClock = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const dateTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** When a preset brings a thread back, as briefly as reads plainly: the time today, the weekday this week, else the date. */
const when = (target: number, now: number): string => {
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (target < today + DAY) return clock.format(target);
  if (target < today + 6 * DAY) return weekdayClock.format(target);
  return dateTime.format(target);
};

/** Later's choices: each preset with the time it lands on at the right, then a time of one's own. */
export function LaterMenuItems({
  onPick,
  onCustom,
}: {
  onPick: (until: number) => void;
  onCustom: () => void;
}) {
  const [now] = useState(Date.now);
  return (
    <>
      {presets.map(({ label, until }) => {
        const target = until(now);
        return (
          <MenuItem
            key={label}
            onClick={() => {
              const pickedAt = Date.now();
              onPick(target > pickedAt ? target : until(pickedAt));
            }}
          >
            <span className="min-w-0 flex-1">{label}</span>
            <time
              dateTime={new Date(target).toISOString()}
              title={dateTime.format(target)}
              className="shrink-0 pl-6 text-caption text-fg-tertiary tabular-nums max-md:text-[13px]"
            >
              {when(target, now)}
            </time>
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem icon={CalendarClock} onClick={onCustom}>
        Custom date and time…
      </MenuItem>
    </>
  );
}

/** A date and time of one's own for Later, in local time, which has to be in the future. */
export function LaterDateDialog({
  onPick,
  onClose,
}: {
  onPick: (until: number) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const submit = () => {
    const until = customLaterTime(value, Date.now());
    if (until === undefined) {
      setError(value === "" ? "Choose a date and time." : "Choose a date and time in the future.");
      field.current?.focus();
      return;
    }
    setOpen(false);
    onPick(until);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      onClosed={onClose}
      title="Custom date and time for Later"
      description="It comes back to the Inbox at the time you choose."
      onSubmit={submit}
      actions={
        <DialogButton tone="primary" type="submit">
          Move to Later
        </DialogButton>
      }
    >
      <DialogField label="Bring back on">
        <DialogInput
          ref={field}
          type="datetime-local"
          value={value}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
        />
      </DialogField>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="-mt-2 text-meta text-error-text max-md:text-[13px]">
          {error}
        </p>
      )}
    </FormDialog>
  );
}
