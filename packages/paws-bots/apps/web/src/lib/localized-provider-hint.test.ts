import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { providerRowHint } from "./localized-provider-hint";

const entry = (overrides: Partial<ModelCatalogEntry>) =>
  ({ provider: "p", id: "m", label: "M", auth: "api-key", ...overrides }) as ModelCatalogEntry;

describe("providerRowHint", () => {
  it("shows nothing for a plain API-key provider", () => {
    expect(providerRowHint(entry({}))).toBeNull();
  });

  it("keeps the hint for sign-in, subscription and custom-server providers", () => {
    expect(providerRowHint(entry({ authHint: "Custom server" }))).toBe("Custom server");
    expect(providerRowHint(entry({ signIn: "device-code" }))).toBe("Sign in");
    expect(providerRowHint(entry({ auth: "oauth" }))).toBe("Skip or deploy key");
  });
});
