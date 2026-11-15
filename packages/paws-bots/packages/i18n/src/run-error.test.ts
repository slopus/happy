import { i18n } from "@lingui/core";
import { MODEL_OUTPUT_CUT_ERROR, MODEL_REQUEST_LIMIT_ERROR, normalizeRunError } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { translateRunError } from "./run-error";

afterEach(() => {
  i18n.activate("en");
});

it("translates connection limits while keeping model recovery", () => {
  const translated = "Das Anfragelimit dieser Verbindung ist zu niedrig. Wähle ein anderes Modell.";
  i18n.load("de", { [MODEL_REQUEST_LIMIT_ERROR]: translated });
  i18n.activate("de");
  expect(
    normalizeRunError(MODEL_REQUEST_LIMIT_ERROR, translateRunError, i18n.locale),
  ).toMatchObject({
    summary: translated,
    recovery: "model",
  });
});

it("uses the active Lingui catalog for shared run errors", () => {
  i18n.load("de", {
    "Your model provider": "Dein Modellanbieter",
    "{provider} is rate limiting requests. Try again shortly.":
      "{provider} drosselt Anfragen. Versuche es gleich noch einmal.",
  });
  i18n.activate("de");
  expect(
    normalizeRunError(
      '429: {"message":"API key rate limit exceeded"}',
      translateRunError,
      i18n.locale,
    ).summary,
  ).toBe("Dein Modellanbieter drosselt Anfragen. Versuche es gleich noch einmal.");
});

it("translates the summary of a reply cut off at the output limit", () => {
  i18n.load("de", {
    [MODEL_OUTPUT_CUT_ERROR]:
      "Das Modell hat sein Ausgabelimit erreicht, bevor es die Antwort fertig geschrieben hat.",
  });
  i18n.activate("de");
  expect(normalizeRunError(MODEL_OUTPUT_CUT_ERROR, translateRunError, i18n.locale)).toMatchObject({
    summary:
      "Das Modell hat sein Ausgabelimit erreicht, bevor es die Antwort fertig geschrieben hat.",
    recovery: "model",
  });
});

it("translates the summary of an internal server error", () => {
  i18n.load("de", {
    "Something went wrong. Try again.": "Etwas ist schiefgelaufen. Versuche es erneut.",
  });
  i18n.activate("de");
  expect(normalizeRunError("Internal server error", translateRunError, i18n.locale)).toMatchObject({
    summary: "Etwas ist schiefgelaufen. Versuche es erneut.",
    details: "Internal server error",
  });
});

it("keeps the English summary of an internal server error when nothing is translated", () => {
  expect(normalizeRunError("Internal server error", translateRunError, "en").summary).toBe(
    "Something went wrong. Try again.",
  );
});
