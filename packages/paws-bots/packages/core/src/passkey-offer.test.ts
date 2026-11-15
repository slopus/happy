import { describe, expect, it } from "vitest";
import { hostMatchesPasskeyRpId, shouldOfferPasskey } from "./passkey-offer.js";

describe("shouldOfferPasskey", () => {
  const created = "2026-10-21T10:00:00.000Z";

  it("offers once in the first session of a new account", () => {
    expect(
      shouldOfferPasskey({
        userCreatedAt: created,
        sessionCreatedAt: "2026-10-21T10:00:01.000Z",
        passkeyCount: 0,
        dismissed: false,
      }),
    ).toBe(true);
  });

  it("stays quiet after dismissal, with a passkey, or in a later session", () => {
    const base = {
      userCreatedAt: created,
      sessionCreatedAt: "2026-10-21T10:00:01.000Z",
      passkeyCount: 0,
      dismissed: false,
    };
    expect(shouldOfferPasskey({ ...base, dismissed: true })).toBe(false);
    expect(shouldOfferPasskey({ ...base, passkeyCount: 1 })).toBe(false);
    expect(shouldOfferPasskey({ ...base, sessionCreatedAt: "2026-10-22T10:00:00.000Z" })).toBe(
      false,
    );
    expect(shouldOfferPasskey({ ...base, sessionCreatedAt: "invalid" })).toBe(false);
  });
});

describe("hostMatchesPasskeyRpId", () => {
  it("accepts the relying party and its subdomains only", () => {
    expect(hostMatchesPasskeyRpId("app.example.com", "app.example.com")).toBe(true);
    expect(hostMatchesPasskeyRpId("eu.app.example.com", "app.example.com")).toBe(true);
    expect(hostMatchesPasskeyRpId("evilapp.example.com", "app.example.com")).toBe(false);
    expect(hostMatchesPasskeyRpId("127.0.0.1", "localhost")).toBe(false);
    expect(hostMatchesPasskeyRpId("localhost", null)).toBe(false);
  });
});
