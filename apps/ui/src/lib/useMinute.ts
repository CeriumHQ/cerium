import { useEffect, useState } from "react";

/** The time now, read again every minute: enough for "5m ago" and "Resets in 2 hr" to stay true. */
export function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
