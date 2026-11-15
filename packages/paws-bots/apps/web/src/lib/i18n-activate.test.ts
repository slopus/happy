import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateUiLocale,
  getActiveUiLocale,
  i18n,
  setCatalogLoadersForTests,
  setUiLocale,
} from "./i18n";
import type { UiLocale } from "./ui-locale";
import { UI_LOCALE_STORAGE_KEY, UI_LOCALES } from "./ui-locale";

vi.mock("./apply-ui-direction", () => ({
  applyUiDirection: vi.fn(),
}));

function stubLocaleStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  });
  return store;
}

describe("activateUiLocale", () => {
  beforeEach(() => {
    setCatalogLoadersForTests(null);
    i18n.load("en", {});
    i18n.activate("en");
    vi.unstubAllGlobals();
  });

  it("falls back to English when the preferred catalog fails to load", async () => {
    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => {
        throw new Error("de catalog missing");
      },
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      "zh-TW": async () => ({ messages: { Settings: "設定" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
      he: async () => ({ messages: { Settings: "הגדרות" } }),
      nl: async () => ({ messages: { Settings: "Instellingen" } }),
      ja: async () => ({ messages: { Settings: "設定" } }),
      pl: async () => ({ messages: { Settings: "Ustawienia" } }),
    });

    const locale = await activateUiLocale("de");
    expect(locale).toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("falls back to empty English when every catalog fails", async () => {
    setCatalogLoadersForTests({
      en: async () => {
        throw new Error("en missing");
      },
      de: async () => {
        throw new Error("de missing");
      },
      ko: async () => {
        throw new Error("ko missing");
      },
      tr: async () => {
        throw new Error("tr missing");
      },
      hi: async () => {
        throw new Error("hi missing");
      },
      "pt-BR": async () => {
        throw new Error("pt-BR missing");
      },
      "zh-TW": async () => {
        throw new Error("zh-TW missing");
      },
      "zh-CN": async () => {
        throw new Error("zh-CN missing");
      },
      es: async () => {
        throw new Error("es missing");
      },
      ru: async () => {
        throw new Error("ru missing");
      },
      fr: async () => {
        throw new Error("fr missing");
      },
      he: async () => {
        throw new Error("he missing");
      },
      nl: async () => {
        throw new Error("nl missing");
      },
      ja: async () => {
        throw new Error("ja missing");
      },
      pl: async () => {
        throw new Error("pl missing");
      },
    });

    const locale = await activateUiLocale("ko");
    expect(locale).toBe("en");
    expect(i18n.locale).toBe("en");
  });

  it("lets the latest locale selection win under concurrency", async () => {
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      "zh-TW": async () => ({ messages: { Settings: "設定" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
      he: async () => ({ messages: { Settings: "הגדרות" } }),
      nl: async () => ({ messages: { Settings: "Instellingen" } }),
      ja: async () => ({ messages: { Settings: "設定" } }),
      pl: async () => ({ messages: { Settings: "Ustawienia" } }),
    });

    const first = activateUiLocale("de");
    const second = activateUiLocale("ko");
    resolveDe({ messages: { Settings: "Einstellungen" } });

    await expect(first).resolves.toBe("ko");
    await expect(second).resolves.toBe("ko");
    expect(getActiveUiLocale()).toBe("ko");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("설정");
  });

  it("cancels a pending activation when re-selecting the already-active locale", async () => {
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      "zh-TW": async () => ({ messages: { Settings: "設定" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
      he: async () => ({ messages: { Settings: "הגדרות" } }),
      nl: async () => ({ messages: { Settings: "Instellingen" } }),
      ja: async () => ({ messages: { Settings: "設定" } }),
      pl: async () => ({ messages: { Settings: "Ustawienia" } }),
    });

    await activateUiLocale("en");
    expect(getActiveUiLocale()).toBe("en");

    const pendingDe = activateUiLocale("de");
    const backToEn = activateUiLocale("en");
    resolveDe({ messages: { Settings: "Einstellungen" } });

    await expect(pendingDe).resolves.toBe("en");
    await expect(backToEn).resolves.toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("does not let a stale setUiLocale fallback overwrite the latest stored locale", async () => {
    const store = stubLocaleStorage();
    let resolveDe!: (value: { messages: Record<string, string> }) => void;
    const dePromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveDe = resolve;
    });

    setCatalogLoadersForTests({
      en: async () => ({ messages: { Settings: "Settings" } }),
      de: async () => dePromise,
      ko: async () => ({ messages: { Settings: "설정" } }),
      tr: async () => ({ messages: { Settings: "Ayarlar" } }),
      hi: async () => ({ messages: { Settings: "सेटिंग्स" } }),
      "pt-BR": async () => ({ messages: { Settings: "Configurações" } }),
      "zh-CN": async () => ({ messages: { Settings: "设置" } }),
      "zh-TW": async () => ({ messages: { Settings: "設定" } }),
      es: async () => ({ messages: { Settings: "Configuración" } }),
      ru: async () => ({ messages: { Settings: "Настройки" } }),
      fr: async () => ({ messages: { Settings: "Paramètres" } }),
      he: async () => ({ messages: { Settings: "הגדרות" } }),
      nl: async () => ({ messages: { Settings: "Instellingen" } }),
      ja: async () => ({ messages: { Settings: "設定" } }),
      pl: async () => ({ messages: { Settings: "Ustawienia" } }),
    });

    await activateUiLocale("en");
    const pendingDe = setUiLocale("de");
    const pendingKo = setUiLocale("ko");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");

    resolveDe({ messages: { Settings: "Einstellungen" } });
    await expect(pendingDe).resolves.toBe("ko");
    await expect(pendingKo).resolves.toBe("ko");
    expect(getActiveUiLocale()).toBe("ko");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");
  });

  it("tells the desktop app the language it activated, even when the desktop refuses", async () => {
    const loaders = Object.fromEntries(
      UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
    ) as Record<UiLocale, () => Promise<{ messages: Record<string, string> }>>;
    setCatalogLoadersForTests(loaders);
    const set = vi.fn(async (_locale: string) => {
      throw new Error("refused");
    });
    vi.stubGlobal("window", { rakazoDesktop: { locale: { set } } });

    await expect(activateUiLocale("es")).resolves.toBe("es");
    expect(set).toHaveBeenCalledWith("es");

    // Older desktop releases have no locale bridge.
    vi.stubGlobal("window", { rakazoDesktop: {} });
    await expect(activateUiLocale("de")).resolves.toBe("de");
    vi.unstubAllGlobals();
  });
});
