export type TextDirection = "ltr" | "rtl";

const RTL_LANGUAGE_PREFIXES = ["ar", "fa", "he", "ur"] as const;

function primaryLanguageTag(localeTag: string): string {
  const normalized = localeTag.trim().toLowerCase();
  const [primary] = normalized.split(/[-_]/);
  return primary ?? normalized;
}

export function textDirectionForLocale(localeTag: string): TextDirection {
  const primary = primaryLanguageTag(localeTag);
  return RTL_LANGUAGE_PREFIXES.includes(primary as (typeof RTL_LANGUAGE_PREFIXES)[number])
    ? "rtl"
    : "ltr";
}
