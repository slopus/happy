import { describe, expect, it } from "vitest";
import {
  emailAllowed,
  isMessagingEmail,
  parseAllowlist,
  signupPolicyFromEnv,
  signupRequiresEmailVerification,
  signupsOpen,
} from "./signup-policy.js";

describe("signup policy", () => {
  it("identifies pending signup consistently across clients without accepting malformed responses", () => {
    expect(signupRequiresEmailVerification({ token: null })).toBe(true);
    for (const response of [
      undefined,
      null,
      {},
      { token: "session-token" },
      { token: "" },
      { token: false },
    ]) {
      expect(signupRequiresEmailVerification(response)).toBe(false);
    }
  });
  it("allows any email when the list is empty", () => {
    expect(emailAllowed("a@x.com", [])).toBe(true);
  });

  it("matches exact addresses and domains case-insensitively", () => {
    const list = parseAllowlist("You@Example.com,@company.com");
    expect(emailAllowed("you@example.com", list)).toBe(true);
    expect(emailAllowed("dev@company.com", list)).toBe(true);
    expect(emailAllowed(" Dev@Company.com ", list)).toBe(true);
    expect(emailAllowed("other@x.com", list)).toBe(false);
  });

  it("does not match a look-alike domain or a longer address", () => {
    const list = parseAllowlist("you@example.com,@company.com");
    expect(emailAllowed("dev@evilcompany.com", list)).toBe(false);
    expect(emailAllowed("dev@company.com.evil.test", list)).toBe(false);
    expect(emailAllowed("eviyou@example.com", list)).toBe(false);
  });

  it("does not match a domain to an address with more than one @", () => {
    const list = parseAllowlist("@company.com");
    expect(emailAllowed("evil@company.com@evil.test", list)).toBe(false);
    expect(emailAllowed("a@b@company.com", list)).toBe(false);
    expect(emailAllowed("@@company.com", list)).toBe(false);
    expect(emailAllowed("a@company.com", list)).toBe(true);
    expect(emailAllowed("a@b@company.com", parseAllowlist("a@b@company.com"))).toBe(true);
    expect(emailAllowed("no-at-sign", list)).toBe(false);
    expect(emailAllowed("company.com", list)).toBe(false);
    expect(emailAllowed("@company.com", list)).toBe(true);
  });

  it("recognizes internal messaging addresses in any case", () => {
    expect(isMessagingEmail(" MSG-1@Messaging.Invalid ")).toBe(true);
    expect(isMessagingEmail("msg-1@messaging.invalid.example.com")).toBe(false);
  });

  it("honors SIGNUPS_ENABLED", () => {
    expect(signupsOpen(undefined)).toBe(true);
    expect(signupsOpen("false")).toBe(false);
    expect(signupsOpen("0")).toBe(false);
  });

  it("builds a normalized policy from environment defaults", () => {
    expect(
      signupPolicyFromEnv({
        signupsEnabled: "false",
        signupAllowlist: " You@Example.com, @company.test ",
      }),
    ).toEqual({ enabled: false, allowlist: ["you@example.com", "@company.test"] });
  });
});
