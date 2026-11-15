import { t } from "@lingui/core/macro";
import type { CronFreq, CronLabels, CronUnit } from "@rakazo/core";
import { ENGLISH_CRON_LABELS, localizedClock, polishInterval, russianInterval } from "@rakazo/core";

/** A schedule frequency as the schedule menus name it. */
export function cronFreqLabel(freq: CronFreq): string {
  switch (freq) {
    case "Every hour":
      return t`Every hour`;
    case "Every day":
      return t`Every day`;
    case "Weekdays":
      return t`Weekdays`;
    // The day is fixed, so the label carries it.
    case "Every week":
      return t`Every Monday`;
    case "Every month":
      return t`Monthly on the 1st`;
    case "Interval":
      return t`Interval`;
    case "Advanced":
      return t`Advanced`;
    default:
      return freq;
  }
}

export function cronUnitLabel(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t`minutes`;
    case "hours":
      return t`hours`;
    case "days":
      return t`days`;
    default:
      return unit;
  }
}

export function cronUnitLabelSingular(unit: CronUnit): string {
  switch (unit) {
    case "minutes":
      return t`minute`;
    case "hours":
      return t`hour`;
    case "days":
      return t`day`;
    default:
      return unit;
  }
}

/**
 * Schedule words for `formatCron` outside the editor — routine rows, the
 * composer `@` picker. Member expressions like `preset.n` extract the same
 * "{0}" catalog ids the editor's strings already carry translations for.
 * Russian and Polish intervals need case forms, so they share core helpers instead
 * of a catalog string.
 */
export function cronLabels(locale: string): CronLabels {
  if (locale === "en") return ENGLISH_CRON_LABELS;
  return {
    oneTime: t`One-time`,
    everyHour: t`Every hour`,
    cron: t`Cron`,
    everyDay: t`Every day`,
    weekdays: t`Weekdays`,
    weekends: t`Weekends`,
    everyMonday: t`Every Monday`,
    monthly: t`Monthly`,
    weekdayNames: [
      t`Sunday`,
      t`Monday`,
      t`Tuesday`,
      t`Wednesday`,
      t`Thursday`,
      t`Friday`,
      t`Saturday`,
    ],
    interval: (n, unit) => {
      if (locale === "ru") return russianInterval(n, unit);
      if (locale === "pl") return polishInterval(n, unit);
      const preset = { n };
      const unitLabel = n === 1 ? cronUnitLabelSingular(unit) : cronUnitLabel(unit);
      return { lead: t`Every`, detail: t`${preset.n} ${unitLabel}` };
    },
    atTime: (time) => {
      const preset = { time: localizedClock(time, locale) };
      return t`at ${preset.time}`;
    },
    onThe1stAt: (time) => {
      const preset = { time: localizedClock(time, locale) };
      return t`on the 1st at ${preset.time}`;
    },
    onDayAt: (day, clock) => {
      const time = localizedClock(clock, locale);
      return t`on day ${day} at ${time}`;
    },
    hourAtMinute: (minute) => t`Every hour at :${String(minute).padStart(2, "0")}`,
    hoursAtMinute: (n, at) => {
      const minute = String(at).padStart(2, "0");
      return t`Every ${n} hours at :${minute}`;
    },
    daySpan: (fromName, toName) => t`${fromName} to ${toName}`,
    everyDays: (names) =>
      names.length === 1
        ? t`Every ${names[0] ?? ""}`
        : t`Every ${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`,
  };
}
