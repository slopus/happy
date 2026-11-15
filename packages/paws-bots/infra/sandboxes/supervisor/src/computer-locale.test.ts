import { describe, expect, it } from "vitest";
import { computerLocaleMatches, resolveComputerLocale } from "./computer-locale.js";
import { containerCreateOptions } from "./computer-spec.js";

describe("computer time zone and language", () => {
  it("keeps an account's time zone and language only when a computer can use them", () => {
    expect(resolveComputerLocale({})).toEqual({});
    expect(resolveComputerLocale({ timezone: null, language: null })).toEqual({});
    expect(resolveComputerLocale({ timezone: " Europe/Warsaw ", language: "pl" })).toEqual({
      timezone: "Europe/Warsaw",
      language: "pl",
    });
    expect(
      resolveComputerLocale({ timezone: "America/Argentina/Buenos_Aires", language: "pt_br" }),
    ).toEqual({ timezone: "America/Buenos_Aires", language: "pt-BR" });
    // The zone files are case-sensitive, so the computer gets Intl's spelling, also for an alias
    // the account saved in another case.
    expect(resolveComputerLocale({ timezone: "europe/warsaw" })).toEqual({
      timezone: "Europe/Warsaw",
    });
    expect(resolveComputerLocale({ timezone: "europe/kyiv" })).toEqual({
      timezone: "Europe/Kiev",
    });
    expect(resolveComputerLocale({ timezone: "Asia/Kolkata" })).toEqual({
      timezone: "Asia/Calcutta",
    });
    expect(resolveComputerLocale({ timezone: "Etc/GMT+3", language: "zh-Hant-TW" })).toEqual({
      timezone: "Etc/GMT+3",
      language: "zh-Hant-TW",
    });
    // Anything else keeps the image default rather than failing the start.
    for (const timezone of ["Mars/Olympus", "../etc/passwd", "Europe/Warsaw\nX=1", "UTC;id", ""])
      expect(resolveComputerLocale({ timezone })).toEqual({});
    for (const language of ["pl;rm", "-x", "pl\nX=1", "en US", "toolongsubtag-abcdefghij", ""])
      expect(resolveComputerLocale({ language })).toEqual({});
  });

  it("starts computers with the owner's time zone and language only when known", () => {
    const base = {
      name: "rakazo-bot-x",
      image: "img",
      botId: "x",
      spaceId: "s",
      homePath: "/data/x",
    };
    const plain = containerCreateOptions(base).Env;
    expect(plain.some((entry) => /^(TZ|LANGUAGE)=/.test(entry))).toBe(false);
    const env = containerCreateOptions({
      ...base,
      locale: { timezone: "Europe/Warsaw", language: "pl" },
    }).Env;
    expect(env).toEqual(expect.arrayContaining(["TZ=Europe/Warsaw", "LANGUAGE=pl"]));
    // The rest of the environment stays as it is.
    expect(env).toEqual(expect.arrayContaining(plain));
  });

  it("matches a computer's time zone and language to the account's", () => {
    const warsaw = { timezone: "Europe/Warsaw", language: "pl" };
    const env = (locale?: typeof warsaw) =>
      containerCreateOptions({
        name: "rakazo-bot-x",
        image: "img",
        botId: "x",
        spaceId: "s",
        homePath: "/data/x",
        ...(locale ? { locale } : {}),
      }).Env;
    expect(computerLocaleMatches(env(), {})).toBe(true);
    expect(computerLocaleMatches(null, undefined)).toBe(true);
    expect(computerLocaleMatches(env(warsaw), warsaw)).toBe(true);
    // A computer from before the account had them, or after they changed, is replaced.
    expect(computerLocaleMatches(env(), warsaw)).toBe(false);
    expect(computerLocaleMatches(env(warsaw), {})).toBe(false);
    expect(computerLocaleMatches(env(warsaw), { ...warsaw, timezone: "Europe/London" })).toBe(
      false,
    );
    expect(computerLocaleMatches(env(warsaw), { timezone: "Europe/Warsaw" })).toBe(false);
  });
});
