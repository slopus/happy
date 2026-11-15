import { authenticatorKey } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { totpCode } from "./totp.js";

// RFC 6238 appendix B: its ASCII seeds in base32, eight digits, 30-second steps. Each seed
// repeats "1234567890", which is "GEZDGNBVGY3TQOJQ" in base32, so they are written in pieces.
const DIGITS = "GEZDGNBVGY3TQOJQ";
const seeds = {
  SHA1: DIGITS.repeat(2),
  SHA256: `${DIGITS.repeat(3)}GEZA`,
  SHA512: `${DIGITS.repeat(6)}GEZDGNA`,
};
const vectors: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("totpCode", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [seconds, ...codes] of vectors) {
      for (const [index, algorithm] of (["SHA1", "SHA256", "SHA512"] as const).entries()) {
        const key = authenticatorKey(
          `otpauth://totp/Example:alice?secret=${seeds[algorithm]}&algorithm=${algorithm}&digits=8`,
        )!;
        expect(totpCode(key, seconds * 1000), `${algorithm} at ${seconds}`).toBe(codes[index]);
      }
    }
  });

  it("reads a setup link whose parameter names are upper case", () => {
    expect(
      authenticatorKey(`otpauth://totp/x?SECRET=${seeds.SHA1}&ALGORITHM=SHA256&DIGITS=8`),
    ).toEqual({ secret: seeds.SHA1, algorithm: "sha256", digits: 8, period: 30 });
  });

  it("reads a pasted base32 key with the usual six digits, and refuses anything else", () => {
    const key = authenticatorKey("gezd gnbv gy3t qojq ".repeat(2).trim())!;
    expect(key).toEqual({ secret: seeds.SHA1, algorithm: "sha1", digits: 6, period: 30 });
    expect(totpCode(key, 59_000)).toBe("287082");
    for (const bad of [
      "not a key",
      "GEZDGNBV",
      `otpauth://hotp/x?secret=${seeds.SHA1}`,
      `otpauth://totp/x?secret=${seeds.SHA1}&algorithm=MD5`,
      `otpauth://totp/x?secret=${seeds.SHA1}&digits=12`,
      `otpauth://totp/x?secret=${seeds.SHA1}&digits=7`,
      `otpauth://totp/x?secret=${seeds.SHA1}&period=45`,
      `otpauth://totp/x?secret=${seeds.SHA1}&period=1`,
    ])
      expect(authenticatorKey(bad), bad).toBeUndefined();
  });

  it("reads the six or eight digits and 30 or 60 seconds authenticator apps use", () => {
    expect(authenticatorKey(`otpauth://totp/x?secret=${seeds.SHA1}&digits=8&period=60`)).toEqual({
      secret: seeds.SHA1,
      algorithm: "sha1",
      digits: 8,
      period: 60,
    });
  });
});
