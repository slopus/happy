import { describe, expect, it, vi } from "vitest";
import type { CronPreset, CronUnit } from "./cron.js";
import {
  CRON_INTERVAL_MAX,
  clampIntervalAmount,
  cronFromPreset,
  cronIntervalAmounts,
  describeCronPreset,
  ENGLISH_CRON_LABELS,
  formatCron,
  hasMixedOneShotSchedule,
  isOneShotRoutineCrons,
  localizedClock,
  nextCronDate,
  nextCronDateAcross,
  nextCronDateAcrossStrict,
  nextRoutineRunDate,
  nextRoutineRunDateAcross,
  ONCE_ROUTINE_CRON,
  polishInterval,
  polishPluralCategory,
  presetFromCron,
  resolveRoutineNextRunAt,
  russianInterval,
  zonedDateTime,
} from "./cron.js";

describe("polishPluralCategory", () => {
  const counts = [0, 1, 2, 4, 5, 12, 14, 21, 22, 101, 102, 112, 0.5, 1.5, 2.2, 12.25];
  const pluralRules = new Intl.PluralRules("pl");

  it.each([...counts, ...counts.map((count) => -count)])(
    "matches Polish Intl cardinal rules for %s",
    (count) => {
      expect(polishPluralCategory(count)).toBe(pluralRules.select(count));
    },
  );

  it("works when the native runtime has no Intl.PluralRules", () => {
    vi.stubGlobal("Intl", {});
    try {
      expect(polishPluralCategory(1)).toBe("one");
      expect(polishPluralCategory(-22)).toBe("few");
      expect(polishPluralCategory(112)).toBe("many");
      expect(polishPluralCategory(-1.5)).toBe("other");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("zonedDateTime", () => {
  it("reads a wall-clock time or date without an offset in the timezone", () => {
    expect(zonedDateTime("2026-11-02T10:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    expect(zonedDateTime("2026-11-02 10:00:30", "UTC")?.toISOString()).toBe(
      "2026-11-02T10:00:30.000Z",
    );
    expect(zonedDateTime("2026-11-02T10:00:00.5", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T09:00:00.500Z",
    );
    expect(zonedDateTime("2026-11-02", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
  });

  it("takes a time with an offset as written", () => {
    expect(zonedDateTime("2026-11-02T10:00:00Z", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T10:00:00.000Z",
    );
    expect(zonedDateTime("2026-11-02T10:00+05:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });

  it.each([
    ["0099-03-01T10:00Z", "0099-03-01T10:00:00.000Z"],
    ["2028-02-29T10:00Z", "2028-02-29T10:00:00.000Z"],
    ["2030-03-01t10:00z", "2030-03-01T10:00:00.000Z"],
    ["2030-03-01T00:30:15.125+05:30", "2030-02-28T19:00:15.125Z"],
    ["2030-02-28T23:30-04:00", "2030-03-01T03:30:00.000Z"],
    ["2030-03-01T00:30+0530", "2030-02-28T19:00:00.000Z"],
    ["2030-03-01T00:30+05", "2030-02-28T19:30:00.000Z"],
    ["2030-02-28T23:30:15-04", "2030-03-01T03:30:15.000Z"],
  ])("preserves the valid offset datetime %s", (value, expected) => {
    expect(zonedDateTime(value, "America/New_York")?.toISOString()).toBe(expected);
  });

  it.each([
    "2030-02-30T10:00Z",
    "2100-02-29T10:00Z",
    "2030-04-31T10:00-04:00",
    "2030-01-01T24:00Z",
    "2030-01-01T10:00+24:00",
    "2030-01-01T10:00+24",
    "2030-01-01T10:00+05:60",
  ])("rejects the impossible offset datetime %s", (value) => {
    expect(zonedDateTime(value, "UTC")).toBeNull();
  });

  it("moves a time skipped by daylight saving forward and keeps the first of a repeated hour", () => {
    expect(zonedDateTime("2026-03-29T02:30", "Europe/Berlin")?.toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(zonedDateTime("2026-10-25T02:30", "Europe/Berlin")?.toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("rejects impossible dates and non-ISO text", () => {
    for (const value of ["2026-02-30", "2026-11-02T24:00", "next monday", "", "2026-11-02T10"]) {
      expect(zonedDateTime(value, "UTC")).toBeNull();
    }
  });
});

function preset(partial: Partial<CronPreset> & Pick<CronPreset, "freq">): CronPreset {
  return {
    n: 3,
    unit: "minutes",
    time: "9:00 AM",
    cron: "",
    ...partial,
  };
}

describe("cronFromPreset", () => {
  it("maps everyday language onto cron", () => {
    expect(cronFromPreset(preset({ freq: "Every day", time: "9:00 AM" }))).toBe("0 9 * * *");
    expect(cronFromPreset(preset({ freq: "Weekdays", time: "8:00 AM" }))).toBe("0 8 * * 1-5");
    expect(cronFromPreset(preset({ freq: "Every week", time: "9:00 AM" }))).toBe("0 9 * * 1");
    expect(cronFromPreset(preset({ freq: "Every month", time: "12:00 PM" }))).toBe("0 12 1 * *");
    expect(cronFromPreset(preset({ freq: "Every hour" }))).toBe("0 * * * *");
    expect(cronFromPreset(preset({ freq: "Every day", time: "12:00 AM" }))).toBe("0 0 * * *");
    expect(cronFromPreset(preset({ freq: "Every day", time: "3:00 PM" }))).toBe("0 15 * * *");
  });

  it("maps intervals including days", () => {
    expect(cronFromPreset(preset({ freq: "Interval", n: 15, unit: "minutes" }))).toBe(
      "*/15 * * * *",
    );
    expect(cronFromPreset(preset({ freq: "Interval", n: 2, unit: "hours" }))).toBe("0 */2 * * *");
    expect(cronFromPreset(preset({ freq: "Interval", n: 3, unit: "days" }))).toBe("0 0 */3 * *");
  });

  it("keeps advanced expressions", () => {
    expect(cronFromPreset(preset({ freq: "Advanced", cron: "0 10 15 * *" }))).toBe("0 10 15 * *");
    expect(cronFromPreset(preset({ freq: "Advanced", cron: "" }))).toBe("*/3 * * * *");
    expect(cronFromPreset(preset({ freq: "Advanced", cron: ONCE_ROUTINE_CRON }))).toBe(
      ONCE_ROUTINE_CRON,
    );
  });
});

describe("presetFromCron", () => {
  it("reads the previous Monday-morning default as weekly", () => {
    expect(presetFromCron("0 9 * * 1")).toMatchObject({
      freq: "Every week",
      time: "9:00 AM",
    });
  });

  it("round-trips the named presets", () => {
    const cases: CronPreset[] = [
      preset({ freq: "Every hour" }),
      preset({ freq: "Every day", time: "6:00 PM" }),
      preset({ freq: "Weekdays", time: "7:00 AM" }),
      preset({ freq: "Every week", time: "9:00 AM" }),
      preset({ freq: "Every month", time: "12:00 PM" }),
      preset({ freq: "Interval", n: 10, unit: "minutes" }),
      preset({ freq: "Interval", n: 5, unit: "hours" }),
      preset({ freq: "Interval", n: 2, unit: "days" }),
      preset({ freq: "Advanced", cron: "0 10 15 * *" }),
    ];
    for (const input of cases) {
      const cron = cronFromPreset(input);
      const parsed = presetFromCron(cron);
      expect(parsed.freq).toBe(input.freq);
      if (input.freq === "Interval") {
        expect(parsed.n).toBe(input.n);
        expect(parsed.unit).toBe(input.unit);
      }
      if (["Every day", "Weekdays", "Every week", "Every month"].includes(input.freq)) {
        expect(parsed.time).toBe(input.time);
      }
      if (input.freq === "Advanced") {
        expect(parsed.cron).toBe(input.cron);
      }
    }
  });

  it("falls back to advanced for expressions the picker cannot represent", () => {
    expect(presetFromCron("0 9 * * 0")).toMatchObject({ freq: "Advanced", cron: "0 9 * * 0" });
    for (const cron of ["0 9 * 3 *", "0 * * * 1", "*/5 * * * 1", "0 9 * *"]) {
      expect(presetFromCron(cron)).toMatchObject({ freq: "Advanced", cron });
    }
    expect(presetFromCron("30 14 15 * *")).toMatchObject({
      freq: "Advanced",
      cron: "30 14 15 * *",
    });
    expect(presetFromCron(ONCE_ROUTINE_CRON)).toMatchObject({
      freq: "Advanced",
      cron: ONCE_ROUTINE_CRON,
    });
  });
});

describe("resolveRoutineNextRunAt", () => {
  it("preserves existing nextRunAt for one-shot routines", () => {
    const existing = new Date("2030-01-01T09:00:00.000Z");
    expect(resolveRoutineNextRunAt(ONCE_ROUTINE_CRON, new Date(), "UTC", existing)).toEqual(
      existing,
    );
    expect(resolveRoutineNextRunAt(ONCE_ROUTINE_CRON, new Date(), "UTC", null)).toBeNull();
  });

  it("computes cron schedules for repeating routines", () => {
    const next = resolveRoutineNextRunAt("*/1 * * * *", new Date(), "UTC", null);
    expect(next?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("localizedClock", () => {
  it.each(["invalid", "25:00", "9:60 PM", "0:30 AM", "13:00 PM", ""])(
    "preserves invalid input %j",
    (time) => {
      expect(localizedClock(time, "es")).toBe(time);
    },
  );
  it("preserves the clock for an invalid locale", () => {
    expect(localizedClock("9:00 PM", "_")).toBe("9:00 PM");
  });
  it("writes a schedule time the way the language does", () => {
    expect(localizedClock("9:00 PM", "es")).toBe("21:00");
    expect(localizedClock("12:00 AM", "es")).toBe("0:00");
    expect(localizedClock("6:30 AM", "de")).toBe("6:30");
    expect(localizedClock("9:00 PM", "en")).toMatch(/^9:00\sPM$/);
  });
});

describe("formatCron", () => {
  it("shows a human schedule instead of the expression", () => {
    expect(formatCron("0 9 * * 1")).toBe("Every Monday at 9:00 AM");
    expect(formatCron("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
    expect(formatCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(formatCron(ONCE_ROUTINE_CRON)).toBe("One-time");
    expect(describeCronPreset(preset({ freq: "Every hour" }))).toEqual({
      lead: "Every hour",
      detail: "",
    });
  });

  it("names any single weekday", () => {
    expect(formatCron("0 6 * * 0")).toBe("Every Sunday at 6:00 AM");
    expect(formatCron("0 6 * * 7")).toBe("Every Sunday at 6:00 AM");
    expect(formatCron("30 18 * * 2")).toBe("Every Tuesday at 6:30 PM");
    expect(formatCron("0 9 * * 3")).toBe("Every Wednesday at 9:00 AM");
    expect(formatCron("0 9 * * 4")).toBe("Every Thursday at 9:00 AM");
    expect(formatCron("0 17 * * 5")).toBe("Every Friday at 5:00 PM");
    expect(formatCron(" 0 0 * * 6 ")).toBe("Every Saturday at 12:00 AM");
  });

  it("keeps the other shapes", () => {
    expect(formatCron("0 6 * * *")).toBe("Every day at 6:00 AM");
    expect(formatCron("0 * * * *")).toBe("Every hour");
    expect(formatCron("0 9 1 * *")).toBe("Monthly on the 1st at 9:00 AM");
    expect(formatCron("0 6 1 * 0")).toBe("Cron 0 6 1 * 0");
    expect(presetFromCron("0 6 * * 0")).toMatchObject({ freq: "Advanced", cron: "0 6 * * 0" });
  });

  it("describes weekends, day lists and day ranges", () => {
    expect(formatCron("0 6 * * 6,0")).toBe("Weekends at 6:00 AM");
    expect(formatCron("0 9 * * 0,6")).toBe("Weekends at 9:00 AM");
    expect(formatCron("0 9 * * 6,7")).toBe("Weekends at 9:00 AM");
    expect(formatCron("0 9 * * 1,3,5")).toBe("Every Monday, Wednesday and Friday at 9:00 AM");
    expect(formatCron("30 7 * * 2,4")).toBe("Every Tuesday and Thursday at 7:30 AM");
    expect(formatCron("0 9 * * 0,3")).toBe("Every Wednesday and Sunday at 9:00 AM");
    expect(formatCron("0 9 * * 2-4")).toBe("Tuesday to Thursday at 9:00 AM");
    expect(formatCron("0 9 * * 5-7")).toBe("Friday to Sunday at 9:00 AM");
    expect(formatCron("0 9 * * 1-3,5")).toBe(
      "Every Monday, Tuesday, Wednesday and Friday at 9:00 AM",
    );
    expect(formatCron("0 8 * * 1,2,3,4,5")).toBe("Weekdays at 8:00 AM");
    expect(formatCron("0 8 * * 0-4")).toBe(
      "Every Monday, Tuesday, Wednesday, Thursday and Sunday at 8:00 AM",
    );
    expect(formatCron("0 8 * * 0-6")).toBe("Every day at 8:00 AM");
  });

  it("singularizes an interval of one instead of 'Every 1 minutes'", () => {
    expect(formatCron("*/1 * * * *")).toBe("Every 1 minute");
    expect(formatCron("0 */1 * * *")).toBe("Every 1 hour");
    expect(formatCron("0 0 */1 * *")).toBe("Every 1 day");
    expect(describeCronPreset(preset({ freq: "Interval", n: 1, unit: "minutes" }))).toEqual({
      lead: "Every",
      detail: "1 minute",
    });
  });

  it("takes translated labels for lists and pickers", () => {
    const labels = {
      ...ENGLISH_CRON_LABELS,
      everyDay: "毎日",
      weekdays: "平日",
      weekdayNames: ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"],
      atTime: (time: string) => `${time}に`,
      everyDays: (names: string[]) => `毎週${names.join("と")}`,
      interval: (n: number, unit: CronUnit) => ({
        lead: "",
        detail: `${n}${unit === "minutes" ? "分" : unit === "hours" ? "時間" : "日"}ごと`,
      }),
    };
    expect(formatCron("0 8 * * 1-5", labels)).toBe("平日 8:00 AMに");
    expect(formatCron("*/15 * * * *", labels)).toBe("15分ごと");
    expect(formatCron("0 9 * * 1,3,5", labels)).toBe("毎週月曜日と水曜日と金曜日 9:00 AMに");
    expect(formatCron("0 6 * * *", labels)).toBe("毎日 6:00 AMに");
  });

  it("keeps Russian interval case forms for n=1 and plural amounts", () => {
    expect(russianInterval(1, "minutes")).toEqual({ lead: "Каждую", detail: "минуту" });
    expect(russianInterval(1, "hours")).toEqual({ lead: "Каждый", detail: "час" });
    expect(russianInterval(5, "minutes")).toEqual({ lead: "Каждые", detail: "5 минут" });
    expect(russianInterval(3, "days")).toEqual({ lead: "Каждые", detail: "3 дня" });
  });

  it.each([
    [1, "minutes", "minutę"],
    [2, "minutes", "2 minuty"],
    [5, "minutes", "5 minut"],
    [12, "minutes", "12 minut"],
    [14, "minutes", "14 minut"],
    [21, "minutes", "21 minut"],
    [22, "minutes", "22 minuty"],
    [1, "hours", "godzinę"],
    [3, "hours", "3 godziny"],
    [13, "hours", "13 godzin"],
    [23, "hours", "23 godziny"],
    [1, "days", "dzień"],
    [2, "days", "2 dni"],
    [5, "days", "5 dni"],
  ] as const)("inflects Polish intervals of %i %s", (count, unit, detail) => {
    expect(polishInterval(count, unit)).toEqual({ lead: "Co", detail });
  });

  it("describes any day of the month", () => {
    expect(formatCron("0 9 15 * *")).toBe("Monthly on the 15th at 9:00 AM");
    expect(formatCron("0 9 2 * *")).toBe("Monthly on the 2nd at 9:00 AM");
    expect(formatCron("0 9 3 * *")).toBe("Monthly on the 3rd at 9:00 AM");
    expect(formatCron("0 9 11 * *")).toBe("Monthly on the 11th at 9:00 AM");
    expect(formatCron("0 9 22 * *")).toBe("Monthly on the 22nd at 9:00 AM");
    expect(formatCron("30 18 31 * *")).toBe("Monthly on the 31st at 6:30 PM");
  });

  it("describes a fixed minute every hour", () => {
    expect(formatCron("15 * * * *")).toBe("Every hour at :15");
    expect(formatCron("5 * * * *")).toBe("Every hour at :05");
  });

  it("describes a fixed minute every few hours", () => {
    expect(formatCron("43 */2 * * *")).toBe("Every 2 hours at :43");
    expect(formatCron("5 */6 * * *")).toBe("Every 6 hours at :05");
    expect(formatCron("0 */2 * * *")).toBe("Every 2 hours");
    expect(formatCron("30 */12 * * *")).toBe("Every 12 hours at :30");
  });

  it("names a fixed minute every few hours only when the step divides the day", () => {
    // */5 runs at 00, 05, 10, 15 and 20, then 00 again: not every five hours.
    expect(formatCron("15 */5 * * *")).toBe("Cron 15 */5 * * *");
    expect(formatCron("15 */7 * * *")).toBe("Cron 15 */7 * * *");
  });

  it("keeps the cron fallback for every few hours when the labels can't say it", () => {
    const { hoursAtMinute: _, ...labels } = ENGLISH_CRON_LABELS;
    expect(formatCron("43 */2 * * *", labels)).toBe("Cron 43 */2 * * *");
  });

  it.each([
    "0 9 * * 1-5/2",
    "0 9 * * MON",
    "0 9 * * 5-1",
    "0 9 * * 8",
    "0 9 1,15 * *",
    "0 9 32 * *",
    "0 9 15 1 *",
    "60 * * * *",
    "15 */1 * * *",
    "15 */24 * * *",
    "60 */2 * * *",
    "15 */2 1 * *",
  ])("keeps the cron fallback for %s", (cron) => {
    expect(formatCron(cron)).toBe(`Cron ${cron}`);
  });

  it.each(["* * 1", "1 * *"])("falls back to cron for out-of-range clocks with %s", (fields) => {
    for (const clock of ["60 24", "60 9", "0 24"]) {
      const cron = `${clock} ${fields}`;
      expect(formatCron(cron)).toBe(`Cron ${cron}`);
    }
  });

  it("formats the clock boundaries", () => {
    expect(formatCron("0 0 * * 2")).toBe("Every Tuesday at 12:00 AM");
    expect(formatCron("59 23 * * 2")).toBe("Every Tuesday at 11:59 PM");
  });
});

describe("nextCronDate", () => {
  it("returns the next matching time today for a daily cron", () => {
    const from = new Date("2026-08-24T10:30:00.000Z");
    expect(nextCronDate("0 11 * * *", from)).toEqual(new Date("2026-08-24T11:00:00.000Z"));
  });

  it("honors day-of-week instead of matching the same hour tomorrow", () => {
    // Monday 13:52 UTC; the weekly slot is Monday 13:00, so the next fire is
    // the following Monday, not Tuesday.
    const from = new Date("2026-08-24T13:52:00.000Z");
    expect(nextCronDate("0 13 * * 1", from)).toEqual(new Date("2026-08-31T13:00:00.000Z"));
  });

  it("maps cron day 7 to Sunday", () => {
    const from = new Date("2026-08-26T12:00:00.000Z"); // Wednesday
    expect(nextCronDate("0 9 * * 7", from)).toEqual(new Date("2026-08-30T09:00:00.000Z"));
  });

  it("supports day 7 inside composite day expressions", () => {
    const from = new Date("2026-08-26T12:00:00.000Z"); // Wednesday
    // 1,7 = Monday and Sunday -> next is Sunday Aug 30.
    expect(nextCronDate("0 9 * * 1,7", from)).toEqual(new Date("2026-08-30T09:00:00.000Z"));
    // 5-7 = Friday, Saturday, Sunday -> next is Friday Aug 28.
    expect(nextCronDate("0 9 * * 5-7", from)).toEqual(new Date("2026-08-28T09:00:00.000Z"));
    expect(nextCronDate("0 9 * * 0-7", from)).toEqual(new Date("2026-08-27T09:00:00.000Z"));
  });

  it("honors day-of-month and month fields", () => {
    const from = new Date("2026-08-24T10:30:00.000Z");
    expect(nextCronDate("0 9 1 * *", from)).toEqual(new Date("2026-09-01T09:00:00.000Z"));
    expect(nextCronDate("0 9 1 10 *", from)).toEqual(new Date("2026-10-01T09:00:00.000Z"));
  });

  it("evaluates the schedule in the routine timezone", () => {
    // 10:00 UTC is 06:00 in New York on the same day, so a 7 AM America/New_York
    // daily slot still fires later the same UTC day.
    const from = new Date("2026-08-24T10:00:00.000Z");
    expect(nextCronDate("0 7 * * *", from, "America/New_York")).toEqual(
      new Date("2026-08-24T11:00:00.000Z"),
    );
  });

  it("falls back to UTC for an unknown timezone", () => {
    const from = new Date("2026-08-24T10:00:00.000Z");
    expect(nextCronDate("0 7 * * *", from, "Mars/Olympus")).toEqual(
      new Date("2026-08-25T07:00:00.000Z"),
    );
  });

  it("keeps the local hour across daylight saving time", () => {
    const from = new Date("2026-03-07T12:01:00.000Z");
    expect(nextCronDate("0 7 * * *", from, "America/New_York")).toEqual(
      new Date("2026-03-08T11:00:00.000Z"),
    );
  });

  it("rejects malformed expressions instead of scheduling one minute later", () => {
    const from = new Date("2026-08-24T10:00:00.000Z");
    expect(() => nextCronDate("61 25 * * *", from)).toThrow();
    expect(() => nextCronDate("not-a-cron", from)).toThrow();
    expect(() => nextCronDate("0 0 9 * * *", from)).toThrow();
  });
});

describe("isOneShotRoutineCrons", () => {
  it("is one-shot only for a single @once schedule", () => {
    expect(isOneShotRoutineCrons([ONCE_ROUTINE_CRON])).toBe(true);
    expect(isOneShotRoutineCrons(["0 9 * * *"])).toBe(false);
    expect(isOneShotRoutineCrons([ONCE_ROUTINE_CRON, "0 9 * * *"])).toBe(false);
    expect(isOneShotRoutineCrons([])).toBe(false);
  });
});

describe("nextCronDateAcross", () => {
  it("returns the nearest next run across every recurring schedule", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(nextCronDateAcross(["0 9 * * *", "0 15 * * *"], from, "UTC")).toEqual(
      new Date("2026-08-24T09:00:00.000Z"),
    );
  });

  it("ignores @once entries and schedules that fail to parse", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(nextCronDateAcross([ONCE_ROUTINE_CRON, "0 9 * * *", "not-a-cron"], from, "UTC")).toEqual(
      new Date("2026-08-24T09:00:00.000Z"),
    );
  });

  it("returns null when nothing is a valid recurring schedule", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(nextCronDateAcross([ONCE_ROUTINE_CRON], from, "UTC")).toBeNull();
    expect(nextCronDateAcross(["not-a-cron"], from, "UTC")).toBeNull();
  });
});

describe("hasMixedOneShotSchedule", () => {
  it("flags @once combined with anything else", () => {
    expect(hasMixedOneShotSchedule([ONCE_ROUTINE_CRON, "0 9 * * *"])).toBe(true);
    expect(hasMixedOneShotSchedule(["0 9 * * *", ONCE_ROUTINE_CRON])).toBe(true);
  });

  it("does not flag a lone schedule of any kind", () => {
    expect(hasMixedOneShotSchedule([ONCE_ROUTINE_CRON])).toBe(false);
    expect(hasMixedOneShotSchedule(["0 9 * * *"])).toBe(false);
    expect(hasMixedOneShotSchedule([])).toBe(false);
  });

  it("does not flag multiple recurring schedules", () => {
    expect(hasMixedOneShotSchedule(["0 9 * * *", "0 15 * * *"])).toBe(false);
  });
});

describe("nextCronDateAcrossStrict", () => {
  it("returns the nearest next run across every recurring schedule", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(nextCronDateAcrossStrict(["0 9 * * *", "0 15 * * *"], from, "UTC")).toEqual(
      new Date("2026-08-24T09:00:00.000Z"),
    );
  });

  it("ignores @once entries", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(nextCronDateAcrossStrict([ONCE_ROUTINE_CRON, "0 9 * * *"], from, "UTC")).toEqual(
      new Date("2026-08-24T09:00:00.000Z"),
    );
  });

  it("throws on a malformed recurring cron even when another entry is valid", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(() => nextCronDateAcrossStrict(["0 9 * * *", "not-a-cron"], from, "UTC")).toThrow();
  });

  it("returns null when the array is empty or only @once", () => {
    const from = new Date("2026-08-24T00:00:00.000Z");
    expect(nextCronDateAcrossStrict([ONCE_ROUTINE_CRON], from, "UTC")).toBeNull();
    expect(nextCronDateAcrossStrict([], from, "UTC")).toBeNull();
  });
});

describe("cronIntervalAmounts", () => {
  it.each(["minutes", "hours", "days"] as const)("only offers runnable %s amounts", (unit) => {
    for (const n of cronIntervalAmounts(unit)) {
      const cron = cronFromPreset({ freq: "Interval", n, unit });
      expect(() => nextCronDate(cron, new Date("2026-01-01T00:00:00Z"))).not.toThrow();
    }
  });

  it("clamps an amount that is too large for the new unit", () => {
    expect(clampIntervalAmount(45, "hours")).toBe(15);
    expect(clampIntervalAmount(45, "days")).toBe(30);
    expect(clampIntervalAmount(45, "minutes")).toBe(45);
  });

  it("keeps a custom amount that fits the unit", () => {
    expect(clampIntervalAmount(7, "hours")).toBe(7);
    expect(clampIntervalAmount(23, "hours")).toBe(23);
    expect(clampIntervalAmount(31, "days")).toBe(31);
    expect(clampIntervalAmount(59, "minutes")).toBe(59);
  });

  it("lists a saved custom amount only when it fits the unit", () => {
    expect(cronIntervalAmounts("minutes", 7)).toContain(7);
    expect(cronIntervalAmounts("hours", 4)).toContain(4);
    expect(cronIntervalAmounts("hours", 4)).toEqual([1, 2, 3, 4, 5, 10, 15]);
    expect(cronIntervalAmounts("hours", 45)).not.toContain(45);
    for (const unit of ["minutes", "hours", "days"] as const) {
      const n = CRON_INTERVAL_MAX[unit];
      expect(cronIntervalAmounts(unit, n)).toContain(n);
      expect(cronIntervalAmounts(unit, n + 1)).not.toContain(n + 1);
    }
  });
});

describe("anchored routine intervals", () => {
  it.each([
    [
      "*/45 * * * *",
      "2026-01-01T00:00:00Z",
      ["2026-01-01T00:45:00Z", "2026-01-01T01:30:00Z", "2026-01-01T02:15:00Z"],
    ],
    [
      "0 */15 * * *",
      "2026-01-01T00:00:00Z",
      ["2026-01-01T15:00:00Z", "2026-01-02T06:00:00Z", "2026-01-02T21:00:00Z"],
    ],
    [
      "0 0 */30 * *",
      "2026-01-01T00:00:00Z",
      [
        "2026-01-31T00:00:00Z",
        "2026-03-02T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "2026-05-01T00:00:00Z",
      ],
    ],
    [
      "0 0 */31 * *",
      "2026-01-01T00:00:00Z",
      ["2026-02-01T00:00:00Z", "2026-03-04T00:00:00Z", "2026-04-04T00:00:00Z"],
    ],
    ["0 0 */2 * *", "2026-01-31T00:00:00Z", ["2026-02-02T00:00:00Z", "2026-02-04T00:00:00Z"]],
  ])("keeps consecutive %s fires at a fixed gap", (cron, start, expected) => {
    let anchor = new Date(start);
    for (const iso of expected) {
      anchor = nextRoutineRunDate(cron, anchor, anchor, "UTC");
      expect(anchor).toEqual(new Date(iso));
    }
  });

  it("keeps day intervals at the same local time across spring and fall DST", () => {
    for (const [start, expected] of [
      ["2026-03-07T05:00:00Z", "2026-03-09T04:00:00Z"],
      ["2026-10-31T04:00:00Z", "2026-11-02T05:00:00Z"],
      ["2026-03-07T12:30:15.123Z", "2026-03-09T11:30:15.123Z"],
    ] as const) {
      const anchor = new Date(start);
      expect(nextRoutineRunDate("0 0 */2 * *", anchor, anchor, "America/New_York")).toEqual(
        new Date(expected),
      );
    }
  });

  it.each([
    ["*/45 * * * *", "2026-01-03T00:00:00Z", "2026-01-03T00:45:00Z"],
    ["0 */15 * * *", "2026-01-03T00:00:00Z", "2026-01-03T12:00:00Z"],
    ["0 0 */30 * *", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"],
  ])("skips missed %s fires without losing phase", (cron, now, expected) => {
    expect(nextRoutineRunDate(cron, new Date("2026-01-01T00:00:00Z"), new Date(now))).toEqual(
      new Date(expected),
    );
  });

  it.each([
    ["*/45 * * * *", "2026-03-08T06:45:00Z", "2026-03-08T07:30:00Z"],
    ["0 */15 * * *", "2026-03-08T05:00:00Z", "2026-03-08T20:00:00Z"],
    ["*/45 * * * *", "2026-11-01T05:45:00Z", "2026-11-01T06:30:00Z"],
    ["0 */15 * * *", "2026-11-01T04:00:00Z", "2026-11-01T19:00:00Z"],
  ])("measures %s as elapsed time across DST", (cron, start, expected) => {
    const anchor = new Date(start);
    expect(nextRoutineRunDate(cron, anchor, anchor, "America/New_York")).toEqual(
      new Date(expected),
    );
  });

  it.each([
    [
      "2026-03-08T05:00:00Z",
      [
        "2026-03-08T10:00:00Z",
        "2026-03-08T16:00:00Z",
        "2026-03-08T22:00:00Z",
        "2026-03-09T04:00:00Z",
      ],
    ],
    [
      "2026-11-01T04:00:00Z",
      [
        "2026-11-01T11:00:00Z",
        "2026-11-01T17:00:00Z",
        "2026-11-01T23:00:00Z",
        "2026-11-02T05:00:00Z",
      ],
    ],
  ])("keeps six-hour cron fires at local 00/06/12/18 across DST from %s", (start, expected) => {
    let anchor = new Date(start);
    for (const iso of expected) {
      anchor = nextRoutineRunDate("0 */6 * * *", anchor, anchor, "America/New_York");
      expect(anchor).toEqual(new Date(iso));
    }
  });

  it.each(["*/15 * * * *", "0 */6 * * *", "0 0 */1 * *"])(
    "keeps already-even %s on cron positions with an off-slot anchor",
    (cron) => {
      const anchor = new Date("2026-03-08T05:07:13Z");
      const now = new Date("2026-03-08T06:11:17Z");
      expect(nextRoutineRunDate(cron, anchor, now, "America/New_York")).toEqual(
        nextCronDate(cron, now, "America/New_York"),
      );
    },
  );

  it("leaves the first run on its existing cron match", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(nextCronDate("0 0 */30 * *", from)).toEqual(new Date("2026-01-31T00:00:00Z"));
  });

  it("rejects a step larger than its field instead of anchoring it", () => {
    const anchor = new Date("2026-01-01T00:00:00Z");
    expect(() => nextRoutineRunDate("*/90 * * * *", anchor, anchor)).toThrow();
  });

  it("falls back to UTC for day intervals with an unknown timezone", () => {
    const anchor = new Date("2026-01-31T00:00:00Z");
    expect(nextRoutineRunDate("0 0 */2 * *", anchor, anchor, "Mars/Olympus")).toEqual(
      new Date("2026-02-02T00:00:00Z"),
    );
  });

  it("keeps calendar-day catch-up in phase across DST", () => {
    expect(
      nextRoutineRunDate(
        "0 0 */2 * *",
        new Date("2026-03-05T05:00:00Z"),
        new Date("2026-03-10T12:00:00Z"),
        "America/New_York",
      ),
    ).toEqual(new Date("2026-03-11T04:00:00Z"));
  });

  it.each(["0 9 * * 1-5", "0 9 * 3 *"])("preserves calendar scheduling for %s", (cron) => {
    const anchor = nextCronDate(cron, new Date("2026-01-01T00:00:00Z"));
    const now = new Date(anchor.getTime() + 120_000);
    expect(nextRoutineRunDate(cron, anchor, now)).toEqual(nextCronDate(cron, now));
  });

  it("anchors the only recurring schedule while skipping one-shot and invalid entries", () => {
    const anchor = new Date("2026-01-31T00:00:00Z");
    expect(
      nextRoutineRunDateAcross(
        ["@once", "invalid", "*/0 * * * *", "*/99 * * * *", "0 0 */30 * *"],
        anchor,
        anchor,
      ),
    ).toEqual(new Date("2026-03-02T00:00:00Z"));
    expect(nextRoutineRunDateAcross(["@once", "invalid"], anchor, anchor)).toBeNull();
  });

  it("keeps a 30-day cron firing on its own matches alongside a weekly schedule", () => {
    const crons = ["0 0 */30 * *", "0 9 * * 1"];
    let anchor = new Date("2026-01-26T09:00:00Z");
    for (const iso of ["2026-01-31T00:00:00Z", "2026-02-01T00:00:00Z", "2026-02-02T09:00:00Z"]) {
      const next = nextRoutineRunDateAcross(crons, anchor, anchor);
      expect(next).toEqual(new Date(iso));
      anchor = new Date(iso);
    }
  });

  it.each([
    ["2026-01-26T09:00:00Z", "2026-01-30T12:00:00Z"],
    ["2026-01-30T12:00:00Z", "2026-01-26T09:00:00Z"],
  ])(
    "uses cron after the later of now and the shared anchor for multiple schedules (%s, %s)",
    (start, now) => {
      expect(
        nextRoutineRunDateAcross(
          ["@once", "invalid", "0 0 */30 * *", "0 9 * * 1"],
          new Date(start),
          new Date(now),
        ),
      ).toEqual(new Date("2026-01-31T00:00:00Z"));
    },
  );
});
