import type { AppLocaleSchema } from "@rakazo/contracts";
import { createContext, useContext } from "react";
import { de } from "./locales/de.js";
import type { LabelKey, Messages } from "./locales/en.js";
import { en } from "./locales/en.js";
import { es } from "./locales/es.js";
import { fr } from "./locales/fr.js";
import { he } from "./locales/he.js";
import { hi } from "./locales/hi.js";
import { ja } from "./locales/ja.js";
import { ko } from "./locales/ko.js";
import { nl } from "./locales/nl.js";
import { pl } from "./locales/pl.js";
import { ptBR } from "./locales/pt-BR.js";
import { ru } from "./locales/ru.js";
import { tr } from "./locales/tr.js";
import { zhCN } from "./locales/zh-CN.js";
import { zhTW } from "./locales/zh-TW.js";

/** The app's languages; the kit has words for every one. */
type PageLocale = (typeof AppLocaleSchema.options)[number];

/**
 * Every word the kit writes on its own (buttons, empty states, accessible names), in the app's
 * shipped languages. A page picks its language with `Page lang`; without one the kit follows the
 * language the host gave the frame, then English. Dates and numbers use the same language.
 */
export const PAGE_LOCALES = [
  "en",
  "de",
  "es",
  "fr",
  "he",
  "hi",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt-BR",
  "ru",
  "tr",
  "zh-CN",
  "zh-TW",
] as const satisfies readonly PageLocale[];

export const PAGE_MESSAGES: Record<PageLocale, Messages> = {
  en,
  de,
  es,
  fr,
  he,
  hi,
  ja,
  ko,
  nl,
  pl,
  "pt-BR": ptBR,
  ru,
  tr,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

// Languages written right to left, by their primary subtag.
const RTL = new Set(["ar", "ckb", "dv", "fa", "he", "iw", "ps", "sd", "ug", "ur", "yi"]);

/** The tag as Intl spells it, or nothing when it is not a language tag. */
function canonical(tag: string | undefined): string | undefined {
  if (typeof tag !== "string" || !tag.trim()) return undefined;
  try {
    return Intl.getCanonicalLocales(tag.trim())[0];
  } catch {
    return undefined;
  }
}

/** The shipped language closest to a tag: exact, then by script or region, then the language. */
export function pageLocaleOf(tag: string | undefined): PageLocale {
  const name = canonical(tag);
  if (!name) return "en";
  const exact = PAGE_LOCALES.find((locale) => locale.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  const parts = name.split("-");
  const language = parts[0]!.toLowerCase();
  if (language === "zh") {
    return parts.some((part) => /^(hant|tw|hk|mo)$/i.test(part)) ? "zh-TW" : "zh-CN";
  }
  if (language === "pt") return "pt-BR";
  if (language === "iw") return "he";
  return PAGE_LOCALES.find((locale) => locale === language) ?? "en";
}

export type Words = {
  /** The shipped language the words come from. */
  locale: PageLocale;
  /** What Intl formats dates and numbers with: the page's own tag when it is valid. */
  intl: string;
  dir: "ltr" | "rtl";
  t: (key: LabelKey, vars?: Record<string, string | number>) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  date: (time: number, options: Intl.DateTimeFormatOptions) => string;
  list: (items: string[]) => string;
  ago: (ms: number) => string;
};

const made = new Map<string, Words>();

/** The words and formats for a language tag; untagged pages read as US English. */
export function wordsFor(tag: string | undefined): Words {
  const key = canonical(tag) ?? "";
  const cached = made.get(key);
  if (cached) return cached;
  const locale = pageLocaleOf(key);
  const intl = key || "en-US";
  const numbers = new Map<string, Intl.NumberFormat>();
  const number = (value: number, options?: Intl.NumberFormatOptions) => {
    const id = JSON.stringify(options ?? {});
    let format = numbers.get(id);
    if (!format) {
      format = new Intl.NumberFormat(intl, options);
      numbers.set(id, format);
    }
    return format.format(value);
  };
  const plurals = new Intl.PluralRules(intl);
  const messages = PAGE_MESSAGES[locale];
  const t = (label: LabelKey, vars: Record<string, string | number> = {}) => {
    const message = messages[label] ?? en[label];
    const count = vars.count;
    const template =
      typeof message === "string"
        ? message
        : (message[plurals.select(typeof count === "number" ? count : Number.NaN)] ??
          message.other);
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = vars[name];
      if (value === undefined) return whole;
      return typeof value === "number" ? number(value) : value;
    });
  };
  const relative = new Intl.RelativeTimeFormat(intl, { style: "long", numeric: "always" });
  const ago = (ms: number) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return relative.format(-seconds, "second");
    if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
    if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), "hour");
    return relative.format(-Math.floor(seconds / 86_400), "day");
  };
  const conjunction = new Intl.ListFormat(intl, { type: "conjunction" });
  const words: Words = {
    locale,
    intl,
    dir: RTL.has(key.split("-")[0]!.toLowerCase()) ? "rtl" : "ltr",
    t,
    number,
    date: (time, options) => new Intl.DateTimeFormat(intl, options).format(time),
    list: (items) => conjunction.format(items),
    ago,
  };
  made.set(key, words);
  return words;
}

/** The language a Page sets for everything inside it. */
export const PageLanguage = createContext<string | undefined>(undefined);

/** The language the host gave the frame, read when no Page sets one. */
export function documentLanguage(): string | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.lang || undefined;
}

export function useWords(): Words {
  return wordsFor(useContext(PageLanguage) ?? documentLanguage());
}
