import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

/** Agent import's own files; a string used only by these belongs to import. */
const IMPORT_FILES = [
  "apps/web/src/lib/agent-import-errors.ts",
  "apps/web/src/pages/shell/agent-import-plan.tsx",
  "apps/web/src/pages/shell/agent-import.tsx",
  "apps/web/src/pages/shell/import-setup-card.tsx",
  "apps/web/src/pages/shell/import-status.ts",
  "apps/web/src/pages/shell/use-agent-import-source.ts",
];
/** Import strings that live in shared files. */
const SHARED_IMPORT_STRINGS = ["Import an agent"];

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

describe("agent import translations", () => {
  it("covers every catalog the app ships", () => {
    const shipped = readdirSync(fileURLToPath(localesDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(shipped).toEqual([...UI_LOCALES].sort());
  });

  it("has every import string translated in every language", () => {
    const ids = catalog("en")
      .filter(
        (entry) =>
          (entry.references.length > 0 &&
            entry.references.every((file) => IMPORT_FILES.includes(file))) ||
          SHARED_IMPORT_STRINGS.includes(entry.id),
      )
      .map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(50);
    for (const locale of UI_LOCALES.filter((item) => item !== "en")) {
      const texts = new Map(catalog(locale).map((entry) => [entry.id, entry.text]));
      const blank = ids.filter((id) => !texts.get(id));
      expect(blank, locale).toEqual([]);
    }
  });
});
