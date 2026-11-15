import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOT_TEMPLATES } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

/** A string used only by these files belongs to bot templates. */
const TEMPLATE_DIR = "apps/web/src/components/bot-templates/";
/** Bot template strings that live in shared files. */
const SHARED_TEMPLATE_STRINGS = ["Bot templates", "Templates"];

const localesDir = new URL("../../../../packages/i18n/locales/", import.meta.url);
const catalog = (locale: string) =>
  readFileSync(fileURLToPath(new URL(`${locale}/messages.po`, localesDir)), "utf8")
    .split("\n\n")
    .filter((block) => !block.includes("#~"))
    .map((block) => {
      const strings = (key: "msgid" | "msgstr") => {
        const match = new RegExp(`^${key} ((?:".*"\\n?)+)`, "m").exec(block);
        return (match?.[1]?.match(/"(?:[^"\\]|\\.)*"/g) ?? [])
          .map((part) => JSON.parse(part) as string)
          .join("");
      };
      return {
        id: strings("msgid"),
        text: strings("msgstr"),
        // `#: apps/web/src/a.tsx apps/mobile/lib/b.ts:12` lines: the web files, with any line
        // numbers removed. Mobile shares the catalog, so a string can also be used there.
        references: (block.match(/^#: .*$/gm) ?? [])
          .flatMap((line) => line.slice(3).split(" "))
          .map((reference) => reference.replace(/:\d+$/, ""))
          .filter((reference) => reference.startsWith("apps/web/")),
      };
    })
    .filter((entry) => entry.id);

describe("bot template translations", () => {
  it("has every bot template string translated in every language", () => {
    const ids = catalog("en")
      .filter(
        (entry) =>
          (entry.references.length > 0 &&
            entry.references.every((file) => file.startsWith(TEMPLATE_DIR))) ||
          SHARED_TEMPLATE_STRINGS.includes(entry.id),
      )
      .map((entry) => entry.id);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const locale of UI_LOCALES.filter((item) => item !== "en")) {
      const texts = new Map(catalog(locale).map((entry) => [entry.id, entry.text]));
      const blank = ids.filter((id) => !texts.get(id));
      expect(blank, locale).toEqual([]);
    }
  });

  it("translates the server's English for every template", () => {
    const ids = new Set(catalog("en").map((entry) => entry.id));
    const missing = BOT_TEMPLATES.flatMap((template) =>
      [template.name, template.summary, template.sample].filter((text) => !ids.has(text)),
    );
    expect(missing).toEqual([]);
  });
});
