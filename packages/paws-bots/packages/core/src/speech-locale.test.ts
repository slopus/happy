import { describe, expect, it } from "vitest";
import { recognitionLocaleTag, speechLocaleTag, supportedSpeechTag } from "./speech-locale.js";

describe("speechLocaleTag", () => {
  it("maps an app locale to a tag the recognizer accepts", () => {
    expect(speechLocaleTag("es")).toBe("es-ES");
    expect(speechLocaleTag("pt-BR")).toBe("pt-BR");
    expect(speechLocaleTag("nl")).toBe("nl-NL");
    expect(speechLocaleTag("ja")).toBe("ja-JP");
    expect(speechLocaleTag("pl")).toBe("pl-PL");
    expect(speechLocaleTag("zh-TW")).toBe("zh-TW");
  });
});

describe("recognitionLocaleTag", () => {
  it.each(["pl", "pl-PL", "pl_PL", "en-US", null])(
    "uses Polish speech recognition for Polish UI with speaker %j",
    (speaker) => {
      expect(recognitionLocaleTag("pl", speaker)).toBe("pl-PL");
    },
  );

  it.each([
    ["es-CL", "es-CL"],
    ["es-MX", "es-MX"],
    ["es_AR", "es-AR"],
    ["es-us", "es-US"],
    ["es-419", "es-MX"],
    ["es", "es-ES"],
    ["es-ES", "es-ES"],
  ])("hears a Spanish speaker on %j as %j", (speaker, tag) => {
    expect(recognitionLocaleTag("es", speaker)).toBe(tag);
  });

  it("keeps the app's language when the speaker's is another one", () => {
    expect(recognitionLocaleTag("es", "en-US")).toBe("es-ES");
    expect(recognitionLocaleTag("nl", "de-DE")).toBe("nl-NL");
    expect(recognitionLocaleTag("es", undefined)).toBe("es-ES");
    expect(recognitionLocaleTag("es", " ")).toBe("es-ES");
  });

  it("keeps the speaker's country for other languages too", () => {
    expect(recognitionLocaleTag("pt-BR", "pt-PT")).toBe("pt-PT");
    expect(recognitionLocaleTag("nl", "nl-BE")).toBe("nl-BE");
    expect(recognitionLocaleTag("en", "en-US-u-mu-celsius")).toBe("en-US");
    expect(recognitionLocaleTag("en", "EN-gb")).toBe("en-GB");
  });

  it("keeps the app's Chinese script over the speaker's region", () => {
    expect(recognitionLocaleTag("zh-TW", "zh-HK")).toBe("zh-TW");
    expect(recognitionLocaleTag("zh-CN", "zh-Hans-SG")).toBe("zh-CN");
  });

  it("follows the speaker whenever the UI is English", () => {
    expect(recognitionLocaleTag("en", "it-IT")).toBe("it-IT");
    expect(recognitionLocaleTag("en", "es-CL")).toBe("es-CL");
    expect(recognitionLocaleTag("en", "es-419")).toBe("es-MX");
    expect(recognitionLocaleTag("en", "pl")).toBe("pl-PL");
    expect(recognitionLocaleTag("en", null)).toBe("en-US");
  });

  it("follows browser languages even when the app ships their catalogs", () => {
    expect(recognitionLocaleTag("en", "es-ES")).toBe("es-ES");
    expect(recognitionLocaleTag("en", "es-419")).toBe("es-MX");
    expect(recognitionLocaleTag("en", "ru-RU")).toBe("ru-RU");
    expect(recognitionLocaleTag("en", "es-CL")).toBe("es-CL");
  });
});

describe("supportedSpeechTag", () => {
  const apple = ["en-AE", "en-GB", "en-US", "es-419", "es-CL", "es-ES", "es-MX", "de-DE"];

  it("keeps a tag the recognizer lists", () => {
    expect(supportedSpeechTag("es-CL", apple)).toBe("es-CL");
    expect(supportedSpeechTag("en_GB", apple)).toBe("en-GB");
  });

  it("falls back to the app's region for the language, then to any region of it", () => {
    expect(supportedSpeechTag("es-AR", apple)).toBe("es-MX");
    expect(supportedSpeechTag("en-DE", apple)).toBe("en-US");
    expect(supportedSpeechTag("de-CH", apple)).toBe("de-DE");
    expect(supportedSpeechTag("es-PE", ["es-419", "es-ES"])).toBe("es-419");
    expect(supportedSpeechTag("pl-DE", ["en-US", "pl-PL"])).toBe("pl-PL");
  });

  it("keeps the tag when the recognizer lists nothing or nothing of its language", () => {
    expect(supportedSpeechTag("es-AR", [])).toBe("es-AR");
    expect(supportedSpeechTag("it-IT", apple)).toBe("it-IT");
  });
});
