import { describe, expect, it } from "vitest";
import {
  buildIdAt,
  CLIENT_UPDATE_REQUIRED,
  clientUpdateRequired,
  compareBuilds,
  formatClientBuild,
  isClientUpdateRequiredError,
  parseClientBuild,
  parseMinimumClientBuilds,
} from "./client-build.js";

describe("client builds", () => {
  it("names a build by its UTC build time", () => {
    expect(buildIdAt(new Date("2026-10-22T09:30:15.987Z"))).toBe("20261022093015");
  });

  it("orders builds and refuses to order anything else", () => {
    expect(compareBuilds("20261022093015", "20261022093016")).toBe(-1);
    expect(compareBuilds("20261022093016", "20261022093015")).toBe(1);
    expect(compareBuilds("20261022093015", "20261022093015")).toBe(0);
    expect(compareBuilds("", "20261022093015")).toBeNull();
    expect(compareBuilds("20261022093015", undefined)).toBeNull();
    expect(compareBuilds("3c6e209", "20261022093015")).toBeNull();
  });

  it("round-trips the request header and rejects malformed ones", () => {
    expect(parseClientBuild(formatClientBuild("web", "20261022093015"))).toEqual({
      kind: "web",
      build: "20261022093015",
    });
    expect(parseClientBuild("mobile/20261001000000")).toEqual({
      kind: "mobile",
      build: "20261001000000",
    });
    for (const header of [null, "", "web", "web/", "cli/20261022093015", "web/2026/1", "web/abc"]) {
      expect(parseClientBuild(header)).toBeNull();
    }
  });

  it("parses per-client minimums and throws on a typo", () => {
    expect(parseMinimumClientBuilds(undefined)).toEqual({});
    expect(parseMinimumClientBuilds(" web=20261022093015 , mobile=20261001000000 ")).toEqual({
      web: "20261022093015",
      mobile: "20261001000000",
    });
    expect(() => parseMinimumClientBuilds("20261022093015")).toThrow(/RAKAZO_MIN_CLIENT_BUILD/);
    expect(() => parseMinimumClientBuilds("desktop=20261022093015")).toThrow();
    expect(() => parseMinimumClientBuilds("web=2026-10-22")).toThrow();
  });

  it("refuses only a named build older than its kind's minimum", () => {
    const minimums = { web: "20261022093015" };
    expect(clientUpdateRequired("web/20261022093014", minimums)).toBe(true);
    expect(clientUpdateRequired("web/20261022093015", minimums)).toBe(false);
    expect(clientUpdateRequired("web/20261023000000", minimums)).toBe(false);
    // Mobile has no minimum here, and callers that name no build are never refused.
    expect(clientUpdateRequired("mobile/20200101000000", minimums)).toBe(false);
    expect(clientUpdateRequired(null, minimums)).toBe(false);
    expect(clientUpdateRequired("web/old", minimums)).toBe(false);
    expect(clientUpdateRequired("web/20200101000000", {})).toBe(false);
  });

  it("recognizes the update-required error by code or status", () => {
    expect(isClientUpdateRequiredError({ code: CLIENT_UPDATE_REQUIRED, status: 426 })).toBe(true);
    expect(isClientUpdateRequiredError({ status: 426 })).toBe(true);
    expect(isClientUpdateRequiredError({ status: 401 })).toBe(false);
    expect(isClientUpdateRequiredError(null)).toBe(false);
  });
});
