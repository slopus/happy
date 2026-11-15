/** A short, localized wait until `iso`, such as "2h 30m" or "3d 4h"; empty when unknown. */
export function formatTimeUntil(iso: string | null, locale: string, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const unit = (value: number, unit: "day" | "hour" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(value);
  const minutes = Math.max(1, Math.ceil((at - now) / 60_000));
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${unit(hours, "hour")} ${unit(minutes % 60, "minute")}`;
  return `${unit(Math.floor(hours / 24), "day")} ${unit(hours % 24, "hour")}`;
}
