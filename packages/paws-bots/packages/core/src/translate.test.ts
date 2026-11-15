import { describe, expect, it } from "vitest";
import { translate } from "./translate.js";

describe("translate", () => {
  const catalog = { "Delete {name}?": "¿Eliminar {name}?", Account: "Cuenta" };

  it("translates from the catalog and fills placeholders", () => {
    expect(translate(catalog, "Account")).toBe("Cuenta");
    expect(translate(catalog, "Delete {name}?", { name: "Scout" })).toBe("¿Eliminar Scout?");
  });

  it("keeps the English message when the catalog lacks it or there is none", () => {
    expect(translate(catalog, "Sign out")).toBe("Sign out");
    expect(translate(undefined, "{count} files", { count: 3 })).toBe("3 files");
  });

  it("reads only the catalog's own entries", () => {
    expect(translate(catalog, "constructor")).toBe("constructor");
    expect(translate(catalog, "toString")).toBe("toString");
  });

  it("leaves a placeholder without a value as written", () => {
    expect(translate(catalog, "Delete {name}?", { other: "x" })).toBe("¿Eliminar {name}?");
    expect(translate(catalog, "Delete {name}?", { toString: "x" })).toBe("¿Eliminar {name}?");
  });
});
