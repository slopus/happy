import { describe, expect, it } from "vitest";
import { textDirectionForLocale } from "./text-direction.js";

describe("textDirectionForLocale", () => {
  it("returns rtl for Hebrew and Arabic locale tags", () => {
    expect(textDirectionForLocale("he")).toBe("rtl");
    expect(textDirectionForLocale("he-IL")).toBe("rtl");
    expect(textDirectionForLocale("ar-EG")).toBe("rtl");
    expect(textDirectionForLocale("fa-IR")).toBe("rtl");
    expect(textDirectionForLocale("ur-PK")).toBe("rtl");
  });

  it("returns ltr for other locales", () => {
    expect(textDirectionForLocale("en")).toBe("ltr");
    expect(textDirectionForLocale("en-US")).toBe("ltr");
    expect(textDirectionForLocale("fr")).toBe("ltr");
    expect(textDirectionForLocale("")).toBe("ltr");
  });
});
