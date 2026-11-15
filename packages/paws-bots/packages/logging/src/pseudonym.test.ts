import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isMonitoringUserId, monitoringPseudonymSecret, monitoringUserId } from "./pseudonym.js";

describe("monitoring user pseudonym", () => {
  it("is stable for a user and secret, and differs across users and secrets", () => {
    const id = monitoringUserId("secret-a", "user-1");
    expect(monitoringUserId("secret-a", "user-1")).toBe(id);
    expect(monitoringUserId("secret-a", "user-2")).not.toBe(id);
    expect(monitoringUserId("secret-b", "user-1")).not.toBe(id);
    expect(isMonitoringUserId(id)).toBe(true);
  });

  it("does not contain or plainly hash the account id, and differs from the analytics id", () => {
    const id = monitoringUserId("secret-a", "user-1");
    expect(id).not.toContain("user-1");
    for (const algorithm of ["sha256", "sha1", "md5"]) {
      expect(id).not.toBe(createHmac(algorithm, "").update("user-1").digest("hex"));
    }
    expect(id).not.toBe(createHmac("sha256", "secret-a").update("user:user-1").digest("hex"));
  });

  it("accepts only hash-shaped ids", () => {
    for (const value of ["user-1", "ada@example.com", "A".repeat(64), "", undefined, 1]) {
      expect(isMonitoringUserId(value)).toBe(false);
    }
  });

  it("reads the analytics pseudonym secret", () => {
    expect(monitoringPseudonymSecret({})).toBeUndefined();
    expect(monitoringPseudonymSecret({ ANALYTICS_PSEUDONYM_SECRET: "  " })).toBeUndefined();
    expect(monitoringPseudonymSecret({ ANALYTICS_PSEUDONYM_SECRET: " s " })).toBe("s");
  });
});
