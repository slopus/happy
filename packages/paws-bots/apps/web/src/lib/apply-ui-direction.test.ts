import { beforeEach, describe, expect, it } from "vitest";
import { applyUiDirection } from "./apply-ui-direction";

describe("applyUiDirection", () => {
  beforeEach(() => {
    globalThis.document = {
      documentElement: {
        dir: "",
        lang: "",
      },
    } as Document;
  });

  it("sets rtl document direction for Hebrew", () => {
    expect(applyUiDirection("he-IL")).toBe("rtl");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("he-IL");
  });

  it("sets ltr document direction for English", () => {
    expect(applyUiDirection("en-US")).toBe("ltr");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en-US");
  });
});
