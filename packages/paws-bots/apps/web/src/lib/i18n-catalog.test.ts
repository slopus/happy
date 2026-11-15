import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n, setupI18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { RUN_ERROR_LIMIT_MESSAGES } from "@rakazo/core";
import { beforeEach, describe, expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

describe("lingui catalogs", () => {
  it("translates sign-out failures in every supported language", () => {
    for (const locale of [
      "de",
      "es",
      "fr",
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
    ]) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      const entry = catalog
        .split("\n\n")
        .find((block) => block.includes('msgid "Could not log out. Try again."\n'));
      const translated = entry?.split("msgstr ")[1];
      expect(translated, locale).toBeTruthy();
      expect(translated, locale).not.toBe('""');
      expect(translated, locale).not.toBe('"Could not log out. Try again."');
    }
  });

  it("translates dictation and voice errors into Spanish", () => {
    const catalog = readFileSync(
      fileURLToPath(new URL("../../../../packages/i18n/locales/es/messages.po", import.meta.url)),
      "utf8",
    );
    for (const message of [
      "Allow Rakazo to use Speech Recognition and the microphone in System Settings.",
      "This browser can't detect when you stop talking. Use Chrome, the desktop app, or hold-to-talk in the composer.",
      "Dictation failed: {code}",
      "Transcription request timed out.",
      "Add a voice provider key and pick a voice in Voice settings.",
      "Voice request timed out.",
    ]) {
      const entry = catalog
        .split("\n\n")
        .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
      const translated = entry?.split("msgstr ")[1];
      expect(translated, message).toBeTruthy();
      expect(translated, message).not.toBe('""');
      if (message.includes("{code}")) expect(translated).toContain("{code}");
    }
  });

  it("localizes provider error guidance and retains its placeholders", () => {
    const messages = [
      ...Object.values(RUN_ERROR_LIMIT_MESSAGES).flatMap(Object.values),
      "{summary} Your backup models also failed.",
      "{summary} No backup model was usable for this request.",
      "{summary} Backup models failed or were unavailable for this request.",
      "Your OpenRouter",
      "Your OpenAI",
      "Your Anthropic",
      "Your model provider",
      "The model provider returned an error.",
      "Connect a model in Settings before running bots.",
      "Connect your own API key in Models or choose Rakazo credits in Billing.",
      "{provider} is rate limiting requests. Try again shortly.",
      "{summary} Resets {date}.",
      "{provider} rejected the API key. Check your connection settings.",
      "{provider} can't run this model.",
      "{provider} took too long to respond. Try again.",
      "{provider} is overloaded right now. Try again in a moment.",
      "{provider} couldn't be reached. Check that it's running.",
      "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.",
      "Details",
    ];
    for (const locale of [
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
    ]) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      for (const message of messages) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        const translated = entry?.split("msgstr ")[1];
        expect(translated, `${locale}: ${message}`).toBeTruthy();
        // "Details" is also the German and Dutch label.
        if ((locale !== "de" && locale !== "nl") || message !== "Details") {
          expect(translated, `${locale}: ${message}`).not.toBe(JSON.stringify(message));
        }
        for (const placeholder of message.match(/\{\w+\}/g) ?? []) {
          expect(translated).toContain(placeholder);
        }
      }
    }
  });

  it("translates bot settings labels and retains placeholders in every locale", () => {
    for (const locale of UI_LOCALES) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      for (const message of [
        "Advanced",
        "Notifications",
        "When it finishes or needs input",
        "Model",
        "Add open work",
        "Disable a tool",
        "Edit name",
        "Enable {0}",
        "Model connections",
        "Permissions",
        "Skills",
      ]) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        expect(entry, `${locale}: ${message}`).toMatch(/msgstr ".+"/);
        const translated = entry?.split("msgstr ")[1] ?? "";
        expect(translated.match(/\{\w+\}/g) ?? [], `${locale}: ${message}`).toEqual(
          message.match(/\{\w+\}/g) ?? [],
        );
      }
    }
  });

  it("names a fixed minute every few hours in every locale", () => {
    for (const locale of UI_LOCALES) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      const entry = catalog
        .split("\n\n")
        .find((block) => block.includes('msgid "Every {n} hours at :{minute}"\n'));
      expect(entry, locale).toMatch(/msgstr ".*\{n\}.*\{minute\}.*"/);
    }
  });

  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("translates command credential controls in every locale", () => {
    const messages = [
      "Command variable",
      "Available to shell commands as {commandVariable}",
      "{commandVariable} is reserved and cannot be used as a command variable. Choose another name.",
      "Show",
      "Hide",
      "Could not show the credential",
    ];
    for (const locale of [
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
    ]) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      for (const message of messages) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        expect(entry, `${locale}: ${message}`).toMatch(/msgstr ".+"/);
        if (message.includes("{commandVariable}")) {
          expect(entry?.split("msgstr ")[1]).toContain("{commandVariable}");
        }
      }
    }
  });

  it("translates model connection preflight feedback in every non-English catalog", () => {
    const locales = [
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
    ];
    const messages = [
      "A subscription credential is stored securely.",
      'Model "{modelId}" was not listed.',
      "Models list OK. {modelCount, plural, one {# model} other {# models}} available. " +
        "Chat was not tested.",
      "Connection test failed.",
      "Test API key",
      "Testing…",
    ];
    for (const locale of locales) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      for (const msgid of messages) {
        const needle = `msgid ${JSON.stringify(msgid)}\nmsgstr "`;
        const at = catalog.indexOf(needle);
        expect(at, `${locale} ${msgid}`).toBeGreaterThanOrEqual(0);
        const end = catalog.indexOf('"\n', at + needle.length);
        const translated = catalog.slice(at + needle.length, end);
        expect(translated.length, `${locale} ${msgid}`).toBeGreaterThan(0);
        expect(translated, `${locale} ${msgid}`).not.toBe(msgid);
        if (msgid.includes("{modelId}")) expect(translated).toContain("{modelId}");
        if (msgid.includes("{modelCount")) {
          expect(translated).toContain("{modelCount, plural,");
          expect(translated).toContain("#");
        }
      }
    }

    const russian = readFileSync(
      fileURLToPath(new URL("../../../../packages/i18n/locales/ru/messages.po", import.meta.url)),
      "utf8",
    );
    expect(russian).toContain(
      "msgstr " +
        '"Список моделей в порядке. {modelCount, plural, one {Доступна # модель} ' +
        "few {Доступны # модели} many {Доступно # моделей} other {Доступно # модели}}. " +
        'Чат не проверялся."',
    );
  });

  it("says how late a run started for one and for many in every locale", () => {
    const ids = ["Started {count}m late", "Started {count}h late", "Started {count}d late"];
    for (const locale of UI_LOCALES.filter((locale) => locale !== "en")) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      const messages = Object.fromEntries(
        ids.map((id) => {
          const entry = catalog
            .split("\n\n")
            .find((block) => block.includes(`msgid ${JSON.stringify(id)}\n`));
          return [id, JSON.parse(entry?.match(/msgstr (".+")/)?.[1] ?? '""') as string];
        }),
      );
      i18n.load(locale, messages);
      i18n.activate(locale);
      for (const id of ids) {
        expect(messages[id], `${locale}: ${id}`).toBeTruthy();
        for (const count of [1, 3]) {
          const label = i18n._({ id, values: { count } });
          expect(label, `${locale}: ${id}`).not.toMatch(/[{}]/);
          if (!(locale === "he" && count === 1 && id.includes("d late"))) {
            expect(label, `${locale}: ${id}`).toContain(String(count));
          }
        }
      }
    }
    i18n.activate("he");
    expect(i18n._({ id: "Started {count}d late", values: { count: 1 } })).toBe(
      "התחיל באיחור של יום",
    );
    expect(i18n._({ id: "Started {count}d late", values: { count: 3 } })).toBe(
      "התחיל באיחור של 3 ימים",
    );
  });

  it("translates counted peer exchanges and close controls in every locale", () => {
    const message = "{count, plural, one {# message with {peer}} other {# messages with {peer}}}";
    for (const locale of UI_LOCALES.filter((locale) => locale !== "en")) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      for (const id of [message, "Close"]) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(id)}\n`));
        const translation = entry?.match(/msgstr "(.+)"/)?.[1];
        expect(translation, `${locale}: ${id}`).toBeTruthy();
        expect(translation).not.toBe(id);
        i18n.load(locale, { [id]: translation ?? "" });
      }
      i18n.activate(locale);
      for (const count of [2, 5, 21]) {
        const label = i18n._({ id: message, values: { count, peer: "Writer" } });
        expect(label).toContain("Writer");
        expect(label).toContain(String(count));
        expect(label).not.toContain("{peer}");
      }
    }
  });
});

it("renders Polish plural categories and interpolated values in every counted message", async () => {
  const filename = fileURLToPath(
    new URL("../../../../packages/i18n/locales/pl/messages.po", import.meta.url),
  );
  const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
    locale: "pl",
    sourceLocale: "en",
    filename,
  });
  const counted = Object.entries(catalog).filter(([, entry]) =>
    entry.message?.includes(", plural,"),
  );
  expect(counted.length).toBeGreaterThanOrEqual(19);
  const local = setupI18n({ locale: "pl" });
  const number = new Intl.NumberFormat("pl");
  for (const [id, entry] of counted) {
    const translation = entry.translation ?? "";
    for (const category of new Intl.PluralRules("pl").resolvedOptions().pluralCategories) {
      expect(translation, entry.message).toContain(`${category} {`);
    }
    local.load("pl", { [id]: translation });
    for (const count of [0, 1, 2, 5, 12, 14, 21, 22, 25, 101, 102, 112, 1.5]) {
      const values = Object.fromEntries(
        [...(entry.message ?? "").matchAll(/\{(\w+)(?=\s*[,}])/g)].map((match) => [
          match[1],
          match[1] === "peer" || match[1] === "name" ? "Locale QA" : count,
        ]),
      );
      const rendered = local._({ id, values });
      expect(rendered, `${entry.message}: ${count}`).toContain(number.format(count));
      expect(rendered).not.toMatch(/[{}]/);
      if ("peer" in values || "name" in values) expect(rendered).toContain("Locale QA");
    }
  }
});

it.each(["zh-CN", "zh-TW", "pl"])(
  "keeps source placeholders and JSX markers in %s translations",
  async (locale) => {
    const readCatalog = async (locale: string) => {
      const filename = fileURLToPath(
        new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
      );
      return formatter().parse(readFileSync(filename, "utf8"), {
        locale,
        sourceLocale: "en",
        filename,
      });
    };
    const source = await readCatalog("en");
    const translated = await readCatalog(locale);
    expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
    const markers = (value: string) =>
      [...new Set(value.match(/\{\w+(?=\s*[,}])|<\/?\d+\s*\/?>/g) ?? [])].sort();
    for (const [id, entry] of Object.entries(source)) {
      const message = entry.message ?? entry.translation ?? id;
      const translation = translated[id]?.translation;
      expect(translation?.trim(), message).toBeTruthy();
      if (!translation?.trim()) continue;
      expect(markers(translation), message).toEqual(markers(message));
    }
  },
);
