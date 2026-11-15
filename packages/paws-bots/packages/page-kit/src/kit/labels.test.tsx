// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MonthView } from "./calendar.js";
import { Table } from "./data.js";
import { EmptyChart } from "./dataviz.js";
import { PAGE_LOCALES, PAGE_MESSAGES, PageLanguage, pageLocaleOf, wordsFor } from "./labels.js";
import { Page } from "./layout.js";
import { Gallery } from "./media.js";
import "./index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

function mount(element: ReactElement) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return host;
}

const placeholders = (message: string) => new Set(message.match(/\{\w+\}/g) ?? []);
const forms = (message: string | Record<string, string>) =>
  typeof message === "string" ? [message] : Object.values(message);

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const longRows = Array.from({ length: 250 }, (_, index) => [`Row ${index}`, index * 1000]);

describe("page words", () => {
  it("cover the app's shipped web languages", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const shipped = readdirSync(join(here, "../../../../packages/i18n/locales"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect([...PAGE_LOCALES].sort()).toEqual(shipped);
  });

  it("give every language every word, with the English placeholders and a plural fallback", () => {
    const english = PAGE_MESSAGES.en;
    const keys = Object.keys(english).sort();
    for (const locale of PAGE_LOCALES) {
      const messages = PAGE_MESSAGES[locale];
      expect(Object.keys(messages).sort(), locale).toEqual(keys);
      for (const key of keys) {
        const message = messages[key as keyof typeof english];
        const source = english[key as keyof typeof english];
        if (typeof message !== "string") expect(message.other, `${locale} ${key}`).toBeTruthy();
        expect(typeof message === "string", `${locale} ${key} plural`).toBe(
          typeof source === "string",
        );
        const allowed = placeholders(forms(source).join(" "));
        for (const form of forms(message)) {
          expect(form.trim(), `${locale} ${key}`).not.toBe("");
          for (const name of placeholders(form))
            expect(allowed, `${locale} ${key}`).toContain(name);
          // A one-off form may spell its count out, but every other form names each value.
          if (typeof message === "string") expect(placeholders(form)).toEqual(allowed);
        }
      }
    }
  });

  it("pick the closest shipped language and fall back to English", () => {
    expect(pageLocaleOf("fr-CA")).toBe("fr");
    expect(pageLocaleOf("zh-Hant")).toBe("zh-TW");
    expect(pageLocaleOf("zh-HK")).toBe("zh-TW");
    expect(pageLocaleOf("zh")).toBe("zh-CN");
    expect(pageLocaleOf("pt-PT")).toBe("pt-BR");
    expect(pageLocaleOf("JA")).toBe("ja");
    expect(pageLocaleOf("pl-PL")).toBe("pl");
    expect(pageLocaleOf("sw")).toBe("en");
    expect(pageLocaleOf("not a tag")).toBe("en");
    expect(pageLocaleOf(undefined)).toBe("en");
    expect(wordsFor("sw").t("showMore")).toBe("Show more");
    // An unknown language keeps its own number format while the words fall back.
    expect(wordsFor("not a tag").number(1234.5)).toBe("1,234.5");
  });

  it("choose plural forms by the language's rules", () => {
    const ru = wordsFor("ru");
    expect(ru.t("ratings", { count: 1 })).toBe("1 оценка");
    expect(ru.t("ratings", { count: 3 })).toBe("3 оценки");
    expect(ru.t("ratings", { count: 5 })).toBe("5 оценок");
    expect(wordsFor("en").t("photos", { count: 1 })).toBe("1 photo");
    expect(wordsFor("en").t("photos", { count: 2 })).toBe("2 photos");
  });

  it.each([
    [0, "0 zdjęć", "0 ocen"],
    [1, "1 zdjęcie", "1 ocena"],
    [2, "2 zdjęcia", "2 oceny"],
    [5, "5 zdjęć", "5 ocen"],
    [12, "12 zdjęć", "12 ocen"],
    [14, "14 zdjęć", "14 ocen"],
    [21, "21 zdjęć", "21 ocen"],
    [22, "22 zdjęcia", "22 oceny"],
    [101, "101 zdjęć", "101 ocen"],
    [102, "102 zdjęcia", "102 oceny"],
    [1.5, "1,5 zdjęcia", "1,5 oceny"],
  ])("inflects Polish photo and rating counts of %s", (count, photos, ratings) => {
    const words = wordsFor("pl-PL");
    expect(words.t("photos", { count })).toBe(photos);
    expect(words.t("ratings", { count })).toBe(ratings);
  });

  it("put the page's language on built-in controls, dates and numbers", () => {
    const root = mount(
      <Page title="Rapport" lang="fr">
        <Table columns={["Nom", "Valeur"]} rows={longRows} />
        <MonthView month="2026-10" />
        <EmptyChart />
      </Page>,
    );
    expect(root.querySelector("input")!.placeholder).toBe("Filtrer les lignes");
    expect(root.querySelector(".rk-table-more button")!.textContent).toBe("Afficher plus");
    expect(root.querySelector(".rk-table-more span")!.textContent).toBe("200 sur 250 affichées");
    expect(root.querySelector(".rk-cal-month")!.getAttribute("aria-label")).toBe("octobre 2026");
    expect(root.querySelector(".rk-cal-month th")!.textContent).toBe("lun.");
    expect(root.querySelector(".rk-chart-empty")!.textContent).toBe("Aucune donnée");
    expect(document.documentElement.lang).toBe("fr");
  });

  it("renders Polish page controls, gallery labels and regional calendar dates", () => {
    const root = mount(
      <Page title="Raport" lang="pl-PL">
        <Table columns={["Nazwa", "Wartość"]} rows={longRows} />
        <MonthView month="2026-10" />
        <Gallery photos={[{ src: PIXEL }, { src: PIXEL }]} />
        <EmptyChart />
      </Page>,
    );
    expect(root.querySelector("input")!.placeholder).toBe("Filtruj wiersze");
    expect(root.querySelector(".rk-table-more button")!.textContent).toBe("Pokaż więcej");
    expect(root.querySelector(".rk-table-more span")!.textContent).toBe("Wyświetlono 200 z 250");
    expect(root.querySelector(".rk-cal-month")!.getAttribute("aria-label")).toBe(
      "październik 2026",
    );
    expect(root.querySelector(".rk-gallery")!.getAttribute("aria-label")).toBe("2 zdjęcia");
    expect(root.querySelector(".rk-gallery-dots button")!.getAttribute("aria-label")).toBe(
      "Pokaż zdjęcie 1",
    );
    expect(root.querySelector(".rk-chart-empty")!.textContent).toBe("Brak danych");
    expect(document.documentElement.lang).toBe("pl-PL");
    expect(wordsFor("pl-PL").number(1234.5)).toBe(new Intl.NumberFormat("pl-PL").format(1234.5));
  });

  it("uses Polish controls when the host supplies Polish and the page has no own language", () => {
    const root = mount(
      <PageLanguage.Provider value="pl-PL">
        <Page title="Raport">
          <EmptyChart />
        </Page>
      </PageLanguage.Provider>,
    );
    expect(root.querySelector(".rk-chart-empty")!.textContent).toBe("Brak danych");
  });

  it("keeps English and US formats for a page with no language", () => {
    const root = mount(
      <Page title="Report">
        <Table columns={["Name", "Value"]} rows={longRows} />
        <EmptyChart />
      </Page>,
    );
    expect(root.querySelector("input")!.placeholder).toBe("Filter rows");
    expect(root.querySelector(".rk-table-more span")!.textContent).toBe("Showing 200 of 250");
    expect(root.querySelector(".rk-chart-empty")!.textContent).toBe("No data");
    expect(root.querySelector("main")!.hasAttribute("dir")).toBe(false);
  });

  it("follow the reader's app language unless the page sets its own", () => {
    // The runtime provides the language the host passed in the boot data.
    const reader = mount(
      <PageLanguage.Provider value="he">
        <Page title="Report">
          <EmptyChart />
        </Page>
      </PageLanguage.Provider>,
    );
    expect(reader.querySelector(".rk-chart-empty")!.textContent).toBe("אין נתונים");
    // The reader's language says nothing about the content, so the page keeps its direction.
    expect(reader.querySelector("main")!.hasAttribute("dir")).toBe(false);
    expect(document.documentElement.hasAttribute("dir")).toBe(false);
    const own = mount(
      <PageLanguage.Provider value="he">
        <Page title="Plan" lang="de">
          <EmptyChart />
        </Page>
      </PageLanguage.Provider>,
    );
    expect(own.querySelector(".rk-chart-empty")!.textContent).toBe("Keine Daten");
    // Outside a page, a language already on the document still applies.
    document.documentElement.lang = "ja";
    expect(mount(<EmptyChart />).textContent).toBe("データなし");
  });

  it("lays a right-to-left page out right to left", () => {
    const root = mount(
      <Page title="דוח" lang="he">
        <Gallery photos={[{ src: PIXEL }, { src: PIXEL }]} />
      </Page>,
    );
    expect(root.querySelector("main")!.getAttribute("dir")).toBe("rtl");
    expect(document.documentElement.dir).toBe("rtl");
    expect(root.querySelector(".rk-gallery")!.getAttribute("aria-label")).toBe("2 תמונות");
    expect(root.querySelector(".rk-gallery-dots button")!.getAttribute("aria-label")).toBe(
      "הצגת תמונה 1",
    );
    expect(wordsFor("en").dir).toBe("ltr");
  });
});
