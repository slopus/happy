import { z } from "zod";

/** The owner's time zone and app language a computer request may carry. */
export const computerLocaleFields = {
  timezone: z.string().max(100).optional(),
  language: z.string().max(100).optional(),
};

/** The owner's clock and app language for a computer; each absent keeps the image default. */
export interface ComputerLocale {
  timezone?: string;
  language?: string;
}

/**
 * The account's time zone and language as a computer can use them, or nothing for a value
 * that is not an IANA zone or a language tag. A bad value keeps the default instead of
 * stopping the computer from starting.
 */
export function resolveComputerLocale(input: {
  timezone?: string | null;
  language?: string | null;
}): ComputerLocale {
  const locale: ComputerLocale = {};
  const timezone = input.timezone?.trim();
  if (timezone && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(timezone)) {
    try {
      // Intl accepts any case, but zone files are case-sensitive, so use Intl's spelling. It may
      // be a legacy link (Asia/Calcutta for Asia/Kolkata); the image's tzdata ships those too.
      locale.timezone = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
      }).resolvedOptions().timeZone;
    } catch {}
  }
  const language = input.language?.trim().replaceAll("_", "-");
  if (language && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(language)) {
    try {
      locale.language = Intl.getCanonicalLocales(language)[0];
    } catch {}
  }
  return locale;
}

/** TZ for the clock; LANGUAGE for the browser and the programs that read it. */
export function computerLocaleEnv(locale: ComputerLocale | undefined) {
  return [
    ...(locale?.timezone ? [`TZ=${locale.timezone}`] : []),
    ...(locale?.language ? [`LANGUAGE=${locale.language}`] : []),
  ];
}

/** Whether a computer runs with this locale; the environment is fixed when it is created. */
export function computerLocaleMatches(
  env: string[] | null | undefined,
  desired: ComputerLocale | undefined,
) {
  const have = (env ?? []).filter((entry) => /^(TZ|LANGUAGE)=/.test(entry)).sort();
  const want = computerLocaleEnv(desired).sort();
  return have.length === want.length && have.every((entry, index) => entry === want[index]);
}
