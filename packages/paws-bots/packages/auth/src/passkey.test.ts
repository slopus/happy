import { describe, expect, it } from "vitest";
import { androidApkKeyHashOrigin, passkeyRelyingParty } from "./passkey.js";

describe("passkeyRelyingParty", () => {
  it("uses the web origin's host so self-hosted domains need no extra setting", () => {
    expect(passkeyRelyingParty("https://chat.example.org/")).toEqual({
      rpID: "chat.example.org",
      origins: ["https://chat.example.org"],
    });
  });

  it("uses localhost for loopback deployments", () => {
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"]) {
      expect(passkeyRelyingParty(origin), origin).toEqual({
        rpID: "localhost",
        origins: ["http://localhost:5173"],
      });
    }
  });

  it("is off where browsers refuse passkeys", () => {
    expect(passkeyRelyingParty("https://192.0.2.10")).toBeNull();
    expect(passkeyRelyingParty("http://chat.example.org")).toBeNull();
    expect(passkeyRelyingParty("not a url")).toBeNull();
  });

  it("accepts the configured Android app signers", () => {
    const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");
    expect(
      passkeyRelyingParty("https://chat.example.org", [fingerprint, "bogus"])?.origins,
    ).toEqual(["https://chat.example.org", ...androidApkKeyHashOrigin(fingerprint)]);
    expect(androidApkKeyHashOrigin(fingerprint)).toEqual([
      `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString("base64url")}`,
    ]);
  });

  it("accepts both encodings Android devices report for the same signer", () => {
    const fingerprint = Array.from({ length: 32 }, () => "FF").join(":");
    expect(androidApkKeyHashOrigin(fingerprint)).toEqual([
      `android:apk-key-hash:${"_".repeat(42)}8`,
      `android:apk-key-hash:${"/".repeat(42)}8`,
    ]);
  });
});
