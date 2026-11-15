import { describe, expect, it } from "vitest";
import { optionalCatalogFeedProbe } from "./optional-catalog-feed";

describe("optionalCatalogFeedProbe", () => {
  it("returns the probe result when the configured feed is available", async () => {
    await expect(
      optionalCatalogFeedProbe(
        Promise.resolve({ enabled: true, results: [{ domain: "github.com" }] }),
      ),
    ).resolves.toEqual({ enabled: true, results: [{ domain: "github.com" }] });
  });

  it("treats an unavailable configured feed as disabled instead of rejecting", async () => {
    await expect(
      optionalCatalogFeedProbe(Promise.reject(new Error("BAD_GATEWAY"))),
    ).resolves.toEqual({ enabled: false, results: [] });
  });
});
