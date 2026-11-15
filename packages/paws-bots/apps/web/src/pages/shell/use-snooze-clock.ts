import { listenWindow } from "../../paws/runtime";
import { nextChatWake } from "@rakazo/core";
import { useEffect, useState } from "react";

// Longer waits re-check, since browsers cap timers and a sleeping laptop stalls them.
const MAX_WAIT_MS = 60 * 60 * 1000;

/** The time the roster reads snoozes against, moved forward when one of these chats wakes. */
export function useSnoozeClock(chats: Iterable<{ snoozedUntil?: string | null }>) {
  const [now, setNow] = useState(Date.now);
  // Against the clock the roster reads, so a wake that passed since it last moved ticks at once.
  const next = nextChatWake(chats, now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    listenWindow("focus", tick);
    if (next === null) return () => window.removeEventListener("focus", tick);
    const timer = window.setTimeout(tick, Math.min(Math.max(next - Date.now(), 0), MAX_WAIT_MS));
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", tick);
    };
  }, [next, now]);
  return now;
}
