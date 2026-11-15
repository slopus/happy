import { Cron, CronDate } from "croner";

const WEEKDAYS = "1-5";
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
// Monday first, so Friday to Sunday reads as one run.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const ONCE_ROUTINE_CRON = "@once";

export function isOneShotRoutineCron(cron: string): boolean {
  return cron.trim() === ONCE_ROUTINE_CRON;
}

export function isOneShotRoutineCrons(crons: string[]): boolean {
  return crons.length === 1 && isOneShotRoutineCron(crons[0] ?? "");
}

// True when @once is combined with any other schedule — never valid, since
// the one-shot slot has no "next run" to compute and would sit inert
// forever. Callers that persist crons must reject this rather than let
// isOneShotRoutineCrons quietly classify the array as recurring.
export function hasMixedOneShotSchedule(crons: string[]): boolean {
  return crons.length > 1 && crons.some(isOneShotRoutineCron);
}

export const CRON_FREQS = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
] as const;

export type CronFreq = (typeof CRON_FREQS)[number];
export type CronUnit = "minutes" | "hours" | "days";

export type CronPreset = {
  freq: CronFreq;
  n: number;
  unit: CronUnit;
  time: string;
  cron: string;
};

export type CronPresetInput = {
  freq: CronFreq;
  n?: number;
  unit?: CronUnit;
  time?: string;
  cron?: string;
};

export function defaultCronPreset(): CronPreset {
  return { freq: "Every day", n: 3, unit: "minutes", time: "9:00 AM", cron: "" };
}

const INTERVAL_AMOUNTS = [1, 2, 3, 5, 10, 15, 30, 45];
export const CRON_INTERVAL_MAX: Record<CronUnit, number> = { minutes: 59, hours: 23, days: 31 };

// Cron steps cannot exceed the field's range, so offer only amounts that fit.
export function cronIntervalAmounts(unit: CronUnit, current?: number): number[] {
  const amounts = INTERVAL_AMOUNTS.filter((n) => n <= CRON_INTERVAL_MAX[unit]);
  if (current === undefined || current > CRON_INTERVAL_MAX[unit] || amounts.includes(current)) {
    return amounts;
  }
  return [...amounts, current].sort((a, b) => a - b);
}

export function clampIntervalAmount(n: number, unit: CronUnit): number {
  if (n <= CRON_INTERVAL_MAX[unit]) return n;
  return cronIntervalAmounts(unit).at(-1) ?? 1;
}

export function cronFromPreset(input: CronPresetInput): string {
  const advancedCron = input.cron?.trim();
  if (input.freq === "Advanced") {
    if (advancedCron && isOneShotRoutineCron(advancedCron)) return ONCE_ROUTINE_CRON;
    return advancedCron || "*/3 * * * *";
  }
  if (input.freq === "Every hour") return "0 * * * *";
  if (input.freq === "Interval") {
    const n = Number.isFinite(input.n) && (input.n ?? 0) > 0 ? (input.n as number) : 5;
    if (input.unit === "days") return `0 0 */${n} * *`;
    if (input.unit === "hours") return `0 */${n} * * *`;
    return `*/${n} * * * *`;
  }
  const { hour, minute } = parseClock(input.time ?? "9:00 AM");
  if (input.freq === "Weekdays") return `${minute} ${hour} * * ${WEEKDAYS}`;
  if (input.freq === "Every week") return `${minute} ${hour} * * 1`;
  if (input.freq === "Every month") return `${minute} ${hour} 1 * *`;
  return `${minute} ${hour} * * *`;
}

export function presetFromCron(cron: string): CronPreset {
  const base = defaultCronPreset();
  const trimmed = cron.trim();
  if (isOneShotRoutineCron(trimmed)) {
    return { ...base, freq: "Advanced", cron: ONCE_ROUTINE_CRON };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 5) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }
  const minute = parts[0] ?? "*";
  const hour = parts[1] ?? "*";
  const day = parts[2] ?? "*";
  const month = parts[3] ?? "*";
  const dow = parts[4] ?? "*";
  if (month !== "*") {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const minuteStep = stepValue(minute);
  const hourStep = stepValue(hour);
  const dayStep = stepValue(day);

  if (minute === "0" && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Every hour" };
  }
  if (minuteStep && hour === "*" && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: minuteStep, unit: "minutes" };
  }
  if (minute === "0" && hourStep && day === "*" && dow === "*") {
    return { ...base, freq: "Interval", n: hourStep, unit: "hours" };
  }
  if (minute === "0" && hour === "0" && dayStep && dow === "*") {
    return { ...base, freq: "Interval", n: dayStep, unit: "days" };
  }
  if (!isCronClock(minute, hour)) {
    return { ...base, freq: "Advanced", cron: trimmed };
  }

  const time = formatClock(Number(hour), Number(minute));
  if (day === "*" && dow === WEEKDAYS) {
    return { ...base, freq: "Weekdays", time };
  }
  if (day === "*" && dow === "1") {
    return { ...base, freq: "Every week", time };
  }
  if (day === "1" && dow === "*") {
    return { ...base, freq: "Every month", time };
  }
  if (day === "*" && dow === "*") {
    return { ...base, freq: "Every day", time };
  }
  return { ...base, freq: "Advanced", cron: trimmed };
}

const CRON_UNIT_SINGULAR: Record<CronUnit, string> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

// The words formatCron puts on screen, so translated surfaces can supply
// their own (web via Lingui, mobile via its catalog). Functions own the
// language-specific grammar — plural forms, ordinals, word order — while the
// schedule parsing stays here.
export type CronLabels = {
  oneTime: string;
  everyHour: string;
  cron: string;
  everyDay: string;
  weekdays: string;
  weekends: string;
  everyMonday: string;
  monthly: string;
  /** Seven names, index 0 = Sunday. */
  weekdayNames: readonly string[];
  interval(n: number, unit: CronUnit): { lead: string; detail: string };
  atTime(time: string): string;
  /** The monthly preset always runs on the 1st, so it gets its own phrase. */
  onThe1stAt(time: string): string;
  onDayAt(day: number, time: string): string;
  hourAtMinute(minute: number): string;
  /** Every few hours at a fixed minute; without it such schedules keep the cron fallback. */
  hoursAtMinute?(hours: number, minute: number): string;
  daySpan(fromName: string, toName: string): string;
  everyDays(names: string[]): string;
};

export const ENGLISH_CRON_LABELS: CronLabels = {
  oneTime: "One-time",
  everyHour: "Every hour",
  cron: "Cron",
  everyDay: "Every day",
  weekdays: "Weekdays",
  weekends: "Weekends",
  everyMonday: "Every Monday",
  monthly: "Monthly",
  weekdayNames: WEEKDAY_NAMES,
  interval: (n, unit) => ({
    lead: "Every",
    detail: `${n} ${n === 1 ? CRON_UNIT_SINGULAR[unit] : unit}`,
  }),
  atTime: (time) => `at ${time}`,
  onThe1stAt: (time) => `on the 1st at ${time}`,
  onDayAt: (day, time) => `on the ${ordinal(day)} at ${time}`,
  hourAtMinute: (minute) => `Every hour at :${String(minute).padStart(2, "0")}`,
  hoursAtMinute: (hours, minute) => `Every ${hours} hours at :${String(minute).padStart(2, "0")}`,
  daySpan: (fromName, toName) => `${fromName} to ${toName}`,
  everyDays: (names) =>
    names.length === 1
      ? `Every ${names[0]}`
      : `Every ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`,
};

// Russian nouns after an amount take one of three case forms; the lead word
// also agrees with the unit's gender. Shared so web and mobile agree.
export function russianPluralForm(value: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(value);
  const mod10 = absolute % 10;
  const mod100 = absolute % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function russianIntervalUnit(value: number, unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return russianPluralForm(value, "минуту", "минуты", "минут");
    case "hours":
      return russianPluralForm(value, "час", "часа", "часов");
    case "days":
      return russianPluralForm(value, "день", "дня", "дней");
    default:
      return unit;
  }
}

export function russianInterval(value: number, unit: CronUnit): { lead: string; detail: string } {
  const lead = value === 1 ? (unit === "minutes" ? "Каждую" : "Каждый") : "Каждые";
  return {
    lead,
    detail:
      value === 1
        ? russianIntervalUnit(value, unit)
        : `${value} ${russianIntervalUnit(value, unit)}`,
  };
}

/** Polish cardinal categories without depending on Intl.PluralRules on native runtimes. */
export function polishPluralCategory(count: number): "one" | "few" | "many" | "other" {
  const absolute = Math.abs(count);
  if (!Number.isInteger(absolute)) return "other";
  if (absolute === 1) return "one";
  const mod10 = absolute % 10;
  const mod100 = absolute % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "few" : "many";
}

/** Polish intervals use the accusative singular and counted plural case forms. */
export function polishInterval(value: number, unit: CronUnit): { lead: string; detail: string } {
  const forms = {
    minutes: { one: "minutę", few: "minuty", many: "minut", other: "minuty" },
    hours: { one: "godzinę", few: "godziny", many: "godzin", other: "godziny" },
    days: { one: "dzień", few: "dni", many: "dni", other: "dnia" },
  } as const;
  const form = forms[unit][polishPluralCategory(value)];
  return { lead: "Co", detail: value === 1 ? form : `${value} ${form}` };
}

export function describeCronPreset(
  preset: CronPreset,
  labels: CronLabels = ENGLISH_CRON_LABELS,
): { lead: string; detail: string } {
  if (preset.freq === "Interval") {
    return labels.interval(preset.n, preset.unit);
  }
  if (preset.freq === "Every hour") {
    return { lead: labels.everyHour, detail: "" };
  }
  if (preset.freq === "Advanced") {
    return { lead: labels.cron, detail: preset.cron || "*/3 * * * *" };
  }
  if (preset.freq === "Weekdays") {
    return { lead: labels.weekdays, detail: labels.atTime(preset.time) };
  }
  if (preset.freq === "Every week") {
    return { lead: labels.everyMonday, detail: labels.atTime(preset.time) };
  }
  if (preset.freq === "Every month") {
    return { lead: labels.monthly, detail: labels.onThe1stAt(preset.time) };
  }
  return { lead: labels.everyDay, detail: labels.atTime(preset.time) };
}

export function formatSchedule(
  preset: CronPreset,
  labels: CronLabels = ENGLISH_CRON_LABELS,
): string {
  const { lead, detail } = describeCronPreset(preset, labels);
  return [lead, detail].filter(Boolean).join(" ");
}

export function formatCron(cron: string, labels: CronLabels = ENGLISH_CRON_LABELS): string {
  if (isOneShotRoutineCron(cron)) return labels.oneTime;
  return describeCronFields(cron, labels) ?? formatSchedule(presetFromCron(cron), labels);
}

// Shapes the editor presets can't represent (they open as "Advanced"), so
// lists and pickers still read as a sentence. Anything else returns null and
// keeps the "Cron …" fallback.
function describeCronFields(cron: string, labels: CronLabels): string | null {
  const [minute = "", hour = "", day = "", month = "", dow = "", ...rest] = cron
    .trim()
    .split(/\s+/);
  if (rest.length > 0 || month !== "*") return null;
  if (hour === "*" && day === "*" && dow === "*" && isInt(minute)) {
    const m = Number(minute);
    return m >= 1 && m <= 59 ? labels.hourAtMinute(m) : null;
  }
  // Only steps that divide the day repeat evenly; "*/5" restarts at midnight after four hours.
  const hours = stepValue(hour);
  if (hours && day === "*" && dow === "*" && isInt(minute)) {
    const m = Number(minute);
    return labels.hoursAtMinute && hours >= 2 && hours < 24 && 24 % hours === 0 && m >= 1 && m <= 59
      ? labels.hoursAtMinute(hours, m)
      : null;
  }
  if (!isCronClock(minute, hour)) return null;
  const time = formatClock(Number(hour), Number(minute));
  if (day === "*" && dow !== "*") {
    const days = cronWeekdays(dow);
    return days ? `${describeWeekdays(days, labels)} ${labels.atTime(time)}` : null;
  }
  if (dow === "*" && isInt(day) && Number(day) >= 1 && Number(day) <= 31) {
    return `${labels.monthly} ${labels.onDayAt(Number(day), time)}`;
  }
  return null;
}

// The day-of-week field as a set of days (0 = Sunday) from single days, lists
// and ranges. Cron also aliases Sunday as 7. Steps and names return null.
function cronWeekdays(field: string): Set<number> | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from > to || to > 7) return null;
    for (let d = from; d <= to; d++) days.add(d % 7);
  }
  return days;
}

function describeWeekdays(days: Set<number>, labels: CronLabels): string {
  if (days.size === 7) return labels.everyDay;
  if (days.size === 5 && !days.has(0) && !days.has(6)) return labels.weekdays;
  if (days.size === 2 && days.has(0) && days.has(6)) return labels.weekends;
  const ordered = WEEK_ORDER.filter((d) => days.has(d));
  const names = ordered.map((d) => labels.weekdayNames[d] ?? WEEKDAY_NAMES[d] ?? "");
  const span = WEEK_ORDER.indexOf(ordered.at(-1) ?? 0) - WEEK_ORDER.indexOf(ordered[0] ?? 0);
  if (names.length >= 3 && span === names.length - 1) {
    return labels.daySpan(names[0] ?? "", names.at(-1) ?? "");
  }
  return labels.everyDays(names);
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function resolveRoutineNextRunAt(
  cron: string,
  from: Date,
  timezone: string,
  existing: Date | null | undefined,
): Date | null {
  if (isOneShotRoutineCron(cron)) return existing ?? null;
  return nextCronDate(cron, from, timezone);
}

export function nextCronDate(cron: string, from: Date, timezone = "UTC"): Date {
  if (isOneShotRoutineCron(cron)) {
    throw new Error("nextCronDate does not apply to one-shot routines");
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new RangeError("Cron expressions must contain five fields");
  }
  const schedule = new Cron(cron, {
    paused: true,
    timezone: validTimezoneOrUtc(timezone),
  });
  const next = schedule.nextRun(from);
  if (!next) throw new RangeError(`Cron expression has no future run: ${cron}`);
  return next;
}

/** The preset of an interval step that recurs from the scheduled fire, or undefined. */
export function unevenInterval(cron: string): CronPreset | undefined {
  const preset = presetFromCron(cron);
  if (
    cron.trim().split(/\s+/).length !== 5 ||
    preset.freq !== "Interval" ||
    preset.n > CRON_INTERVAL_MAX[preset.unit] ||
    (preset.unit === "minutes" && 60 % preset.n === 0) ||
    (preset.unit === "hours" && 24 % preset.n === 0) ||
    (preset.unit === "days" && preset.n === 1)
  ) {
    return undefined;
  }
  return preset;
}

// Uneven interval steps recur from the scheduled fire instead of resetting at
// cron field boundaries. Even steps keep cron's local wall-clock positions.
// Creation/editing still uses nextCronDate for the initial anchor.
export function nextRoutineRunDate(cron: string, anchor: Date, now: Date, timezone = "UTC"): Date {
  const from = new Date(Math.max(anchor.getTime(), now.getTime()));
  const preset = unevenInterval(cron);
  if (!preset) return nextCronDate(cron, from, timezone);
  if (preset.unit !== "days") {
    const gap = preset.n * (preset.unit === "hours" ? 3_600_000 : 60_000);
    const steps = Math.floor((from.getTime() - anchor.getTime()) / gap) + 1;
    return new Date(anchor.getTime() + steps * gap);
  }

  const zone = validTimezoneOrUtc(timezone);
  const localAnchor = new CronDate(anchor, zone);
  const localNow = new CronDate(from, zone);
  // CronDate stores months zero-based, like Date.
  const anchorDay = Date.UTC(localAnchor.year, localAnchor.month, localAnchor.day);
  const nowDay = Date.UTC(localNow.year, localNow.month, localNow.day);
  let steps = Math.max(1, Math.floor((nowDay - anchorDay) / (preset.n * 86_400_000)));
  let next: Date;
  do {
    const day = new Date(anchorDay + steps * preset.n * 86_400_000);
    // Normalize the calendar date before letting Croner resolve its wall-clock
    // time in the routine zone (including daylight saving transitions).
    const candidate = new CronDate(localAnchor, zone);
    candidate.year = day.getUTCFullYear();
    candidate.month = day.getUTCMonth();
    candidate.day = day.getUTCDate();
    next = new Date(candidate.getDate().getTime() + localAnchor.ms);
    steps++;
  } while (next <= from);
  return next;
}

// The shared anchor belongs to an interval only with one recurring schedule.
// Multiple schedules keep cron matches because their individual anchors are
// unknown. Skip one-shot and malformed schedules as nextCronDateAcross does.
export function nextRoutineRunDateAcross(
  crons: string[],
  anchor: Date,
  now: Date,
  timezone = "UTC",
): Date | null {
  const from = new Date(Math.max(anchor.getTime(), now.getTime()));
  const recurring: string[] = [];
  let earliest: Date | null = null;
  for (const cron of crons) {
    if (isOneShotRoutineCron(cron)) continue;
    let next: Date;
    try {
      next = nextCronDate(cron, from, timezone);
    } catch {
      continue;
    }
    recurring.push(cron);
    if (!earliest || next < earliest) earliest = next;
  }
  const onlyCron = recurring.length === 1 ? recurring[0] : undefined;
  if (onlyCron) return nextRoutineRunDate(onlyCron, anchor, now, timezone);
  return earliest;
}

// Nearest next calendar match, ignoring one-shot and malformed schedules.
// Routine wakeups use nextRoutineRunDateAcross to preserve single-interval phase.
// Anything persisting crons must reject malformed input instead — see
// nextCronDateAcrossStrict.
export function nextCronDateAcross(crons: string[], from: Date, timezone = "UTC"): Date | null {
  let earliest: Date | null = null;
  for (const cron of crons) {
    if (isOneShotRoutineCron(cron)) continue;
    let next: Date;
    try {
      next = nextCronDate(cron, from, timezone);
    } catch {
      continue;
    }
    if (!earliest || next < earliest) earliest = next;
  }
  return earliest;
}

// Throws on the first malformed recurring cron instead of skipping it, so a persisted
// routine never keeps a bad entry that silently never fires.
export function nextCronDateAcrossStrict(
  crons: string[],
  from: Date,
  timezone = "UTC",
): Date | null {
  let earliest: Date | null = null;
  for (const cron of crons) {
    if (isOneShotRoutineCron(cron)) continue;
    const next = nextCronDate(cron, from, timezone);
    if (!earliest || next < earliest) earliest = next;
  }
  return earliest;
}

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * An ISO date or datetime as an instant. One with an offset (or Z) is taken as written; a date
 * or wall-clock time without one is read in `timezone`, so "2026-11-02T10:00" is 10:00 there.
 * A time skipped by a daylight-saving change moves forward by the gap. Null when invalid.
 */
export function zonedDateTime(value: string, timezone = "UTC"): Date | null {
  const text = value.trim();
  const wall = ISO_DATE_TIME.exec(text);
  if (!wall) return null;
  const [year, month, day, hour, minute, second] = wall
    .slice(1, 7)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const ms = wall[7] ? Math.floor(Number(`0.${wall[7]}`) * 1000) : 0;
  const check = new Date(0);
  check.setUTCFullYear(year ?? 0, (month ?? 1) - 1, day ?? 1);
  check.setUTCHours(hour ?? 0, minute ?? 0, second ?? 0);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== (month ?? 1) - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  if (wall[8]) {
    // Date only parses an offset with minutes; ISO 8601 also allows hours alone (+05).
    const instant = new Date(/^[+-]\d{2}$/.test(wall[8]) ? `${text}:00` : text);
    return Number.isFinite(instant.getTime()) ? instant : null;
  }
  const local = new CronDate(new Date(), validTimezoneOrUtc(timezone));
  local.year = check.getUTCFullYear();
  local.month = check.getUTCMonth();
  local.day = check.getUTCDate();
  local.hour = check.getUTCHours();
  local.minute = check.getUTCMinutes();
  local.second = check.getUTCSeconds();
  local.ms = 0;
  // Keep any fraction so a time just after an occurrence does not include it.
  return new Date(local.getDate().getTime() + ms);
}

/** The local date and time of `instant` in `timezone`, as zonedDateTime reads it back. */
export function wallClock(instant: Date, timezone = "UTC"): string {
  const local = new CronDate(instant, validTimezoneOrUtc(timezone));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${local.year}-${pad(local.month + 1)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}

function validTimezoneOrUtc(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return "UTC";
  }
}

function parseClock(time: string): { hour: number; minute: number } {
  const [rawH, rest] = time.split(":");
  const minute = Number((rest ?? "00").slice(0, 2));
  let hour = Number(rawH);
  if (/pm/i.test(time) && hour < 12) hour += 12;
  if (/am/i.test(time) && hour === 12) hour = 0;
  return { hour, minute };
}

/**
 * A schedule time ("9:00 PM") the way `locale` writes clock times ("21:00"). Presets keep
 * the English form as their value.
 */
export function localizedClock(time: string, locale: string): string {
  if (!/^\d{1,2}:\d{2}(?:\s[AP]M)?$/i.test(time)) return time;
  const { hour, minute } = parseClock(time);
  const rawHour = Number(time.split(":")[0]);
  if (minute > 59 || hour > 23 || (/[AP]M/i.test(time) && (rawHour < 1 || rawHour > 12)))
    return time;
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
      new Date(2000, 0, 1, hour, minute),
    );
  } catch {
    return time;
  }
}

function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

function stepValue(expr: string): number | null {
  const match = /^\*\/(\d+)$/.exec(expr);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isInt(expr: string): boolean {
  return /^\d+$/.test(expr);
}

function isCronClock(minute: string, hour: string): boolean {
  return isInt(minute) && Number(minute) <= 59 && isInt(hour) && Number(hour) <= 23;
}
