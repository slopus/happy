import type { SpendingCurrency, SpendingPeriod } from "@rakazo/contracts";
import { MAX_SPENDING_LIMIT } from "@rakazo/contracts";
import { wallClock, zonedDateTime } from "./cron.js";

// A symbol another currency shares is read as the one listed. Nearly every other dollar or pound is
// worth less, so a page in one is over-counted; the Cayman Islands dollar, worth a little more, is the
// exception, and the page browser's amount drops the "CI" before a bare "$".
const CURRENCY_MARKS: Array<[RegExp, SpendingCurrency]> = [
  [/\$|\bUSD\b/i, "usd"],
  [/€|\bEUR\b/i, "eur"],
  [/£|\bGBP\b/i, "gbp"],
  [/₪|\b(?:ILS|NIS)\b|ש["״]ח/i, "ils"],
];
// The page browser's own number pattern: thousands may be grouped with spaces, as in "1 234,56", and
// separators before the first digit are kept, so ".99" is not read as 99.
const NUMBER = /[.,]*\d(?:[\d.,]|[ \u00a0\u202f](?=\d{3}))*/g;
// The payments table stores amounts as a 32-bit integer.
const MAX_AMOUNT = 2_147_483_647;

/**
 * An amount a checkout page shows, such as "$1,234.56", "1 234,56 €" or "₪50", in minor units and
 * its currency. Null when it names no currency a limit can be set in, more than one, or no single
 * number, or a number written in no usual way. An ambiguous "$1.234" reads as 1234 dollars, the
 * larger reading.
 */
export function parsePageAmount(
  text: string,
): { amount: number; currency: SpendingCurrency } | null {
  if (text.length > 1000) return null;
  const currencies = new Set(
    CURRENCY_MARKS.filter(([mark]) => mark.test(text)).map(([, currency]) => currency),
  );
  // A yen or any other currency sign beside one of ours leaves the currency in doubt.
  if (currencies.size !== 1 || /[¥₩₹₽₺₴฿₫]/.test(text)) return null;
  const numbers = text.match(NUMBER) ?? [];
  if (numbers.length !== 1) return null;
  const amount = minorUnits(numbers[0]!);
  return amount === null ? null : { amount, currency: [...currencies][0]! };
}

// Whole units grouped in threes by one separator ("1,234,567", "1 234"), then an optional decimal part of
// one or two digits after the other separator ("1.234,56"); or plain digits with an optional decimal part,
// where the whole part may be left out (".99", ",50").
const GROUPED = /^(\d{1,3}(?:([.,\s])\d{3})(?:\2\d{3})*)(?:([.,])(\d{1,2}))?$/;
const PLAIN = /^(?=[.,]?\d)(\d*)(?:[.,](\d{1,2}))?$/;

function minorUnits(number: string): number | null {
  const text = number.replace(/[  ]/g, " ").trim().replace(/[.,]$/, "");
  const grouped = GROUPED.exec(text);
  const plain = grouped ? null : PLAIN.exec(text);
  if (grouped && grouped[3] === grouped[2]) return null;
  const whole = grouped ? grouped[1]!.replace(/[.,\s]/g, "") : plain?.[1];
  const fraction = grouped ? grouped[4] : plain?.[2];
  if (whole === undefined) return null;
  const amount = Number(whole) * 100 + Number((fraction ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount <= MAX_AMOUNT ? amount : null;
}

/**
 * A limit amount the user typed, such as "200", "1,000" or "12,50", in minor units. Null for
 * anything else, zero, or more than the largest limit.
 */
export function parseLimitInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d(?:[\d.,\s\u00a0\u202f]*\d)?[.,]?$/.test(trimmed)) return null;
  const amount = minorUnits(trimmed);
  return amount && amount <= MAX_SPENDING_LIMIT ? amount : null;
}

/**
 * When the current period of a spending limit began: midnight today, Monday's midnight or the
 * first of the month in the user's timezone, or when the limit was set for one that never resets.
 */
export function spendingPeriodStart(
  period: SpendingPeriod,
  startsAt: Date,
  timezone: string | null | undefined,
  now = new Date(),
): Date {
  if (period === "none") return startsAt;
  const zone = timezone || "UTC";
  const [year, month, day] = wallClock(now, zone).slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const back =
    period === "week" ? (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7 : 0;
  const first = new Date(Date.UTC(year, month - 1, period === "month" ? 1 : day - back));
  return zonedDateTime(first.toISOString().slice(0, 10), zone) ?? first;
}

/** An amount in minor units as money, such as "$12.50". */
export function formatMinorAmount(amount: number, currency: string, locale = "en-US"): string {
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
    });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
