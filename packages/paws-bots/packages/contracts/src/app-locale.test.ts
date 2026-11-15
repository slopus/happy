import { describe, expect, it } from "vitest";
import { AppLocaleSchema } from "./domain.js";

describe("AppLocaleSchema", () => {
  it("accepts the app's language codes and nothing else", () => {
    for (const locale of ["es", "en", "pl", "pt-BR", "zh-CN", "zh-TW"]) {
      expect(AppLocaleSchema.safeParse(locale).success, locale).toBe(true);
    }
    for (const locale of [
      "xx",
      "fil",
      "es-ES",
      "pl-PL",
      "",
      "ES",
      "es_ES",
      "es-es",
      "es-ES-x-private",
      "<b>",
      "e".repeat(40),
    ]) {
      expect(AppLocaleSchema.safeParse(locale).success, locale).toBe(false);
    }
  });
});
