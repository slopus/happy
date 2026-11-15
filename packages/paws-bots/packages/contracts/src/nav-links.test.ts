import { describe, expect, it } from "vitest";
import { navLinkSandbox, parseNavLinks } from "./nav-links.js";

describe("parseNavLinks", () => {
  it("is empty when unset", () => {
    expect(parseNavLinks(undefined)).toEqual([]);
    expect(parseNavLinks("  ")).toEqual([]);
  });

  it("parses same-origin links and keeps them untrusted by default", () => {
    expect(
      parseNavLinks(
        JSON.stringify([
          { id: "clients", label: "Clients", path: "/ext/clients/" },
          { id: "approvals", label: "Approvals", path: "/ext/approvals/?view=open", trusted: true },
        ]),
      ),
    ).toEqual([
      { id: "clients", label: "Clients", path: "/ext/clients/", trusted: false },
      { id: "approvals", label: "Approvals", path: "/ext/approvals/?view=open", trusted: true },
    ]);
  });

  it.each([
    "https://example.com/",
    "//example.com/",
    "/\\example.com",
    "javascript:alert(1)",
    "ext/clients",
    "/app",
    "/app/board",
    "/api/me",
    "/rpc/me",
    "/novnc/",
    "/health",
    "/ext/../api/me",
  ])("rejects the path %s", (path) => {
    expect(() => parseNavLinks(JSON.stringify([{ id: "x", label: "X", path }]))).toThrow(
      "RAKAZO_NAV_LINKS",
    );
  });

  it.each([
    ["malformed JSON", "[{"],
    ["a non-array", JSON.stringify({ id: "x", label: "X", path: "/x" })],
    ["a bad id", JSON.stringify([{ id: "Clients", label: "X", path: "/x" }])],
    ["an empty label", JSON.stringify([{ id: "x", label: " ", path: "/x" }])],
    ["an unknown field", JSON.stringify([{ id: "x", label: "X", path: "/x", icon: "users" }])],
    [
      "duplicate ids",
      JSON.stringify([
        { id: "x", label: "X", path: "/x" },
        { id: "x", label: "Y", path: "/y" },
      ]),
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => parseNavLinks(value)).toThrow("RAKAZO_NAV_LINKS");
  });
});

describe("navLinkSandbox", () => {
  it("grants the page its origin only when trusted", () => {
    expect(navLinkSandbox({ trusted: false })).not.toContain("allow-same-origin");
    expect(navLinkSandbox({ trusted: true })).toContain("allow-same-origin");
    for (const trusted of [false, true])
      expect(navLinkSandbox({ trusted })).not.toContain("allow-top-navigation");
  });
});
