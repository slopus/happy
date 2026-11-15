import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it } from "vitest";
import { agentImportErrorText } from "./agent-import-errors";
import { UI_LOCALES } from "./ui-locale";

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("an import the server refused", () => {
  it("is shown in the app's own words, by its reason", () => {
    const error = new ORPCError("CONFLICT", {
      message: "A skill with that name was just added. Try again.",
      data: { reason: "name_just_taken" },
    });
    expect(agentImportErrorText(error)).toBe(
      "Something with the same name was just added. Try again.",
    );
    expect(
      agentImportErrorText(new ORPCError("BAD_REQUEST", { data: { reason: "model_needs_key" } })),
    ).toBe("Connect this model's provider first.");
  });

  it("names the provider whose imported key was rejected", () => {
    const error = new ORPCError("BAD_REQUEST", {
      data: { reason: "key_rejected", provider: "OpenRouter" },
    });
    expect(agentImportErrorText(error)).toBe(
      "OpenRouter rejected the API key. Check your connection settings.",
    );
    // Any other key failure gets general words, never the provider's text.
    expect(
      agentImportErrorText(
        new ORPCError("BAD_REQUEST", {
          message: "upstream said something",
          data: { reason: "key_check_failed" },
        }),
      ),
    ).toBe("An imported API key could not be used. Untick it and try again.");
  });

  it("is translated in every language", () => {
    for (const locale of UI_LOCALES.filter((item) => item !== "en")) {
      const catalog = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/i18n/locales/${locale}/messages.po`, import.meta.url),
        ),
        "utf8",
      );
      for (const message of [
        "{provider} rejected the API key. Check your connection settings.",
        "An imported API key could not be checked. Try again.",
        "An imported API key could not be used. Untick it and try again.",
        "Something with the same name was just added. Try again.",
      ]) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(message)}\n`));
        const translated = entry?.split("msgstr ")[1]?.trim();
        expect(translated, `${locale}: ${message}`).toBeTruthy();
        expect(translated, `${locale}: ${message}`).not.toBe('""');
        expect(translated, `${locale}: ${message}`).not.toBe(JSON.stringify(message));
      }
    }
  });

  it("leaves any other error to the usual handling", () => {
    expect(agentImportErrorText(new ORPCError("BAD_REQUEST", { message: "x" }))).toBeUndefined();
    expect(agentImportErrorText(new Error("offline"))).toBeUndefined();
  });
});
