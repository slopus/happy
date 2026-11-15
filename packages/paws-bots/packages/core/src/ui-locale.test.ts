import { describe, expect, it } from "vitest";
import { matchUiLocale } from "./ui-locale.js";

const ALL = ["en", "de", "es", "he", "pl", "pt-BR", "ru", "zh-CN", "zh-TW"] as const;
const FEW = ["en", "de", "zh-CN"] as const;

describe("matchUiLocale", () => {
  it("maps regional, underscored, and cased tags onto a supported locale", () => {
    expect(matchUiLocale("de-DE", ALL)).toBe("de");
    expect(matchUiLocale(" RU ", ALL)).toBe("ru");
    expect(matchUiLocale("ru_KZ", ALL)).toBe("ru");
    expect(matchUiLocale("pt", ALL)).toBe("pt-BR");
    expect(matchUiLocale("es-419", ALL)).toBe("es");
    expect(matchUiLocale("pl-PL", ALL)).toBe("pl");
    expect(matchUiLocale(" PL_pl ", ALL)).toBe("pl");
    expect(matchUiLocale("iw-IL", ALL)).toBe("he");
    expect(matchUiLocale("zh_Hans_CN", ALL)).toBe("zh-CN");
    expect(matchUiLocale("zh-SG", ALL)).toBe("zh-CN");
  });

  it("keeps Traditional and Simplified Chinese apart, script before region", () => {
    expect(matchUiLocale("zh-TW", ALL)).toBe("zh-TW");
    expect(matchUiLocale("zh-Hant-HK", ALL)).toBe("zh-TW");
    expect(matchUiLocale("zh_MO", ALL)).toBe("zh-TW");
    expect(matchUiLocale("zh-Hans-TW", ALL)).toBe("zh-CN");
    expect(matchUiLocale("zh-TW", FEW)).toBe("en");
  });

  it.each([
    ["zh-MY", "zh-CN"],
    [" ZH_my ", "zh-CN"],
    ["zh-MY-u-ca-chinese", "zh-CN"],
    ["zh-SG-u-ca-chinese", "zh-CN"],
    ["zh-u-ca-chinese", "zh-CN"],
    ["zh-x-hant", "zh-CN"],
    ["zh-Hans-TW-u-ca-chinese", "zh-CN"],
    ["zh-Hant-MY-u-ca-chinese", "zh-TW"],
    ["zh-HK-u-ca-chinese", "zh-TW"],
    ["zh-TW-x-hans", "zh-TW"],
    ["en-Hant-TW", "en"],
    ["de-HK-u-ca-chinese", "de"],
  ])("matches %s without treating extension subtags as a script or region", (tag, locale) => {
    expect(matchUiLocale(tag, ALL)).toBe(locale);
  });

  it("falls back to English for locales the surface does not ship", () => {
    expect(matchUiLocale("pt-BR", FEW)).toBe("en");
    expect(matchUiLocale("es-MX", FEW)).toBe("en");
    expect(matchUiLocale("pl-PL", FEW)).toBe("en");
    expect(matchUiLocale("iw", FEW)).toBe("en");
    expect(matchUiLocale("zh-MY", ["en", "de"])).toBe("en");
    expect(matchUiLocale("zh-SG-u-ca-chinese", ["en", "de"])).toBe("en");
    expect(matchUiLocale("zh-Hant-MY-u-ca-chinese", FEW)).toBe("en");
    expect(matchUiLocale("sv-SE", ALL)).toBe("en");
    expect(matchUiLocale("", ALL)).toBe("en");
    expect(matchUiLocale(null, ALL)).toBe("en");
  });
});
