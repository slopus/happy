/** Calendar comparisons use the viewer's local zone, including DST transitions. */
function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function needsTimeSeparator(current: string | Date, previous?: string | Date): boolean {
  const date = new Date(current);
  if (Number.isNaN(date.getTime())) return false;
  if (previous === undefined) return true;
  const before = new Date(previous);
  return (
    !Number.isNaN(before.getTime()) &&
    (dayNumber(date) !== dayNumber(before) || date.getTime() - before.getTime() >= 15 * 60_000)
  );
}

export function formatTimeSeparator(
  createdAt: string | Date,
  locale: string,
  labels: { today: string; yesterday: string },
  now: Date = new Date(),
): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const daysAgo = dayNumber(now) - dayNumber(date);
  const timeFallback = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const format = (options: Intl.DateTimeFormatOptions, fallback: string): string => {
    try {
      return new Intl.DateTimeFormat(locale, options).format(date);
    } catch {
      // Hermes builds and invalid/unsupported locales must never prevent opening a thread.
      return fallback;
    }
  };
  const time = format({ hour: "numeric", minute: "2-digit" }, timeFallback);
  if (daysAgo === 0 || daysAgo === 1) {
    return `${daysAgo === 0 ? labels.today : labels.yesterday} ${time}`;
  }
  const dateFallback = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (daysAgo > 1 && daysAgo < 7) {
    return `${format({ weekday: "long" }, dateFallback)} ${time}`;
  }
  return format(
    {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    },
    `${dateFallback} ${timeFallback}`,
  );
}

/** Compute before reversing a native inverted list; hidden rows must be removed by the caller. */
export function timeSeparatorIds<T extends { id: string; createdAt?: string }>(
  messages: T[],
): Set<string> {
  const ids = new Set<string>();
  let previous: string | undefined;
  for (const message of messages) {
    if (!message.createdAt) continue;
    if (needsTimeSeparator(message.createdAt, previous)) ids.add(message.id);
    previous = message.createdAt;
  }
  return ids;
}
