import { APP_LOCALE_LABELS } from "@rakazo/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeUiLocale,
  persistUiLocale,
  resolveUiLocale,
  UI_LOCALE_STORAGE_KEY,
  UI_LOCALES,
} from "./ui-locale";

describe("normalizeUiLocale", () => {
  it.each(["pl", "pl-PL", "pl_PL", " PL-pl "])("maps %s to Polish", (tag) => {
    expect(normalizeUiLocale(tag)).toBe("pl");
  });

  it("offers Polish in the language picker", () => {
    expect(UI_LOCALES).toContain("pl");
    expect(APP_LOCALE_LABELS.pl).toBe("Polski");
  });

  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("de-DE")).toBe("de");
    expect(normalizeUiLocale("ko-KR")).toBe("ko");
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeUiLocale("pt")).toBe("pt-BR");
    expect(normalizeUiLocale("hi-IN")).toBe("hi");
    expect(normalizeUiLocale("DE")).toBe("de");
    expect(normalizeUiLocale("es")).toBe("es");
    expect(normalizeUiLocale("es-ES")).toBe("es");
    expect(normalizeUiLocale("es-MX")).toBe("es");
    expect(normalizeUiLocale("es-419")).toBe("es");
    expect(normalizeUiLocale("ES")).toBe("es");
    expect(normalizeUiLocale("es_AR")).toBe("es");
    expect(normalizeUiLocale("ru-RU")).toBe("ru");
    expect(normalizeUiLocale("ru_KZ")).toBe("ru");
    expect(normalizeUiLocale(" RU ")).toBe("ru");
    expect(normalizeUiLocale("fr")).toBe("fr");
    expect(normalizeUiLocale("fr-FR")).toBe("fr");
    expect(normalizeUiLocale("fr-CA")).toBe("fr");
    expect(normalizeUiLocale("FR")).toBe("fr");
    expect(normalizeUiLocale("fr_BE")).toBe("fr");
    expect(normalizeUiLocale("he")).toBe("he");
    expect(normalizeUiLocale("he-IL")).toBe("he");
    expect(normalizeUiLocale("HE")).toBe("he");
    expect(normalizeUiLocale("he_IL")).toBe("he");
    expect(normalizeUiLocale("nl")).toBe("nl");
    expect(normalizeUiLocale("nl-NL")).toBe("nl");
    expect(normalizeUiLocale("nl-BE")).toBe("nl");
    expect(normalizeUiLocale("NL")).toBe("nl");
    expect(normalizeUiLocale("nl_nl")).toBe("nl");
    expect(normalizeUiLocale("ja")).toBe("ja");
    expect(normalizeUiLocale("ja-JP")).toBe("ja");
    expect(normalizeUiLocale("ja_JP")).toBe("ja");
    expect(normalizeUiLocale("iw")).toBe("he");
    expect(normalizeUiLocale("iw-IL")).toBe("he");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_cn")).toBe("zh-CN");
    expect(normalizeUiLocale("ZH-cn")).toBe("zh-CN");
    expect(normalizeUiLocale(" zh-CN ")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_Hans_CN")).toBe("zh-CN");
  });

  it.each([
    "zh-TW",
    "zh_TW",
    " ZH-tw ",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
    "zh-TW-u-nu-hanidec",
    "zh-Hant-CN",
  ])("maps %s to Traditional Chinese", (tag) => expect(normalizeUiLocale(tag)).toBe("zh-TW"));

  it("honors an explicit Simplified script in Traditional Chinese regions", () => {
    expect(normalizeUiLocale("zh-Hans-TW")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(normalizeUiLocale("en-TW")).toBe("en");
    expect(normalizeUiLocale("de-HK")).toBe("de");
  });

  it("falls back to English for unknown locales", () => {
    expect(normalizeUiLocale("sv-SE")).toBe("en");
    expect(normalizeUiLocale("")).toBe("en");
    expect(normalizeUiLocale(null)).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("resolves Polish from browser, environment and saved preferences", () => {
    expect(resolveUiLocale({ stored: null, envDefault: null, navigatorLanguage: "pl-PL" })).toBe(
      "pl",
    );
    expect(resolveUiLocale({ stored: null, envDefault: "pl", navigatorLanguage: "en" })).toBe("pl");
    expect(resolveUiLocale({ stored: "pl", envDefault: "de", navigatorLanguage: "en" })).toBe("pl");
    expect(resolveUiLocale({ stored: "en", envDefault: "pl", navigatorLanguage: "pl-PL" })).toBe(
      "en",
    );
  });

  it("prefers the saved choice over env and navigator", () => {
    expect(
      resolveUiLocale({
        stored: "ko",
        envDefault: "de",
        navigatorLanguage: "en-US",
      }),
    ).toBe("ko");
  });

  it("uses VITE_DEFAULT_UI_LOCALE when nothing is saved", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "de-AT",
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("de");
  });

  it("uses navigator.language next, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("ko");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "zh-CN",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "es-MX",
      }),
    ).toBe("es");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "ru-RU",
      }),
    ).toBe("ru");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "fr-FR",
      }),
    ).toBe("fr");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "nl-NL",
      }),
    ).toBe("nl");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: null,
      }),
    ).toBe("en");
  });

  it("reads localStorage via the storage helper", () => {
    const storage = {
      getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "de" : null),
    };
    expect(resolveUiLocale({ storage, envDefault: null, navigatorLanguage: null })).toBe("de");
  });
});

describe("blocked storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("falls back to the browser language and skips saving when reading storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    expect(resolveUiLocale({ envDefault: null, navigatorLanguage: "de-DE" })).toBe("de");
    expect(() => persistUiLocale("de")).not.toThrow();
  });
});

describe("persistUiLocale", () => {
  it("writes the storage key", () => {
    const store = new Map<string, string>();
    persistUiLocale("ko", {
      setItem: (key, value) => {
        store.set(key, value);
      },
    });
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");
  });
});

describe("Traditional Chinese preferences", () => {
  it("uses the device locale and lets a saved choice override it", () => {
    expect(resolveUiLocale({ stored: null, envDefault: null, navigatorLanguage: "zh-TW" })).toBe(
      "zh-TW",
    );
    expect(resolveUiLocale({ stored: "zh-TW", envDefault: "en", navigatorLanguage: "zh-CN" })).toBe(
      "zh-TW",
    );
    expect(
      resolveUiLocale({ stored: "zh-CN", envDefault: "zh-TW", navigatorLanguage: "zh-TW" }),
    ).toBe("zh-CN");
    expect(resolveUiLocale({ stored: null, envDefault: "zh-TW", navigatorLanguage: "en" })).toBe(
      "zh-TW",
    );
  });
});
