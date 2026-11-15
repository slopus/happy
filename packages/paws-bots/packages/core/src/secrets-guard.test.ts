import { describe, expect, it } from "vitest";
import {
  DEV_AUTH_SECRET_PLACEHOLDER,
  DEV_ENCRYPTION_KEY_PLACEHOLDER,
  DEV_SCREEN_PROXY_SECRET_PLACEHOLDER,
  DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
  encryptionKeyWarning,
  hasValidBearerToken,
  resolveAuthSecret,
  resolveContentEncryption,
  resolveEncryptionKey,
  resolveScreenProxySecret,
  resolveSupervisorToken,
  resolveUpdaterToken,
  timingSafeStringEqual,
} from "./secrets-guard.js";

describe("secrets-guard", () => {
  it("allows placeholders in test mode", () => {
    expect(resolveAuthSecret({ NODE_ENV: "test" })).toBe(DEV_AUTH_SECRET_PLACEHOLDER);
    expect(resolveEncryptionKey({ NODE_ENV: "test" })).toBe(DEV_ENCRYPTION_KEY_PLACEHOLDER);
    expect(resolveSupervisorToken({ NODE_ENV: "test" })).toBe(DEV_SUPERVISOR_TOKEN_PLACEHOLDER);
    expect(resolveScreenProxySecret({ NODE_ENV: "test" })).toBe(
      DEV_SCREEN_PROXY_SECRET_PLACEHOLDER,
    );
    expect(resolveAuthSecret({ NODE_ENV: "production", VITEST: "true" })).toBe(
      DEV_AUTH_SECRET_PLACEHOLDER,
    );
    expect(resolveAuthSecret({ NODE_ENV: "production", RAKAZO_ALLOW_DEV_SECRETS: "1" })).toBe(
      DEV_AUTH_SECRET_PLACEHOLDER,
    );
  });

  it("rejects missing secrets outside local/test", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => resolveEncryptionKey({ NODE_ENV: "production" })).toThrow(/ENCRYPTION_KEY/);
    expect(() => resolveSupervisorToken({ NODE_ENV: "production" })).toThrow(
      /SANDBOX_SUPERVISOR_TOKEN/,
    );
    expect(() => resolveScreenProxySecret({ NODE_ENV: "production" })).toThrow(
      /SCREEN_PROXY_SECRET/,
    );
  });

  it("rejects placeholder values outside local/test", () => {
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER,
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: DEV_ENCRYPTION_KEY_PLACEHOLDER,
      }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: "replace-with-32-plus-character-supervisor-token",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
    expect(() =>
      resolveScreenProxySecret({
        NODE_ENV: "production",
        SCREEN_PROXY_SECRET: DEV_SCREEN_PROXY_SECRET_PLACEHOLDER,
      }),
    ).toThrow(/SCREEN_PROXY_SECRET/);
    expect(() =>
      resolveScreenProxySecret({
        NODE_ENV: "production",
        SCREEN_PROXY_SECRET: "replace-with-32-plus-character-screen-proxy-secret",
      }),
    ).toThrow(/SCREEN_PROXY_SECRET/);
  });

  it("rejects blank and whitespace-padded placeholder secrets in production", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "   " })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => resolveEncryptionKey({ NODE_ENV: "production", ENCRYPTION_KEY: "\t" })).toThrow(
      /ENCRYPTION_KEY/,
    );
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: ` ${DEV_AUTH_SECRET_PLACEHOLDER}\n`,
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: `${DEV_ENCRYPTION_KEY_PLACEHOLDER} `,
      }),
    ).toThrow(/ENCRYPTION_KEY/);
  });

  it("does not treat disabled Vitest flags as a test environment", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production", VITEST: "0" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => resolveEncryptionKey({ NODE_ENV: "production", VITEST: "false" })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it("accepts real dedicated credentials in production", () => {
    expect(
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("prod-supervisor-token-with-enough-length");
    expect(
      resolveScreenProxySecret({
        NODE_ENV: "production",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_SUPERVISOR_TOKEN: "prod-supervisor-token-with-enough-length",
      }),
    ).toBe("prod-screen-proxy-secret-with-enough-length");
  });

  it("accepts real secrets in production", () => {
    expect(
      resolveAuthSecret({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-secret-with-enough-entropy-here",
      }),
    ).toBe("prod-secret-with-enough-entropy-here");
    expect(
      resolveEncryptionKey({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-entropy",
      }),
    ).toBe("prod-encryption-key-with-enough-entropy");
  });

  it("keeps an existing non-placeholder encryption key usable during upgrades", () => {
    expect(resolveEncryptionKey({ NODE_ENV: "production", ENCRYPTION_KEY: "existing-key" })).toBe(
      "existing-key",
    );
  });

  it("warns about a weak production encryption key without rejecting it", () => {
    expect(
      encryptionKeyWarning({ NODE_ENV: "production", ENCRYPTION_KEY: "existing-key" }),
    ).toMatch(/ENCRYPTION_KEY/);
    expect(
      encryptionKeyWarning({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "replace-with-64-random-hex-characters",
      }),
    ).toMatch(/ENCRYPTION_KEY/);
    expect(
      encryptionKeyWarning({ NODE_ENV: "production", ENCRYPTION_KEY: "a".repeat(64) }),
    ).toBeUndefined();
    expect(encryptionKeyWarning({ NODE_ENV: "development" })).toBeUndefined();
  });

  it("requires dedicated supervisor and screen-proxy credentials", () => {
    expect(
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("supervisor-only");
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "custom-auth",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toThrow(/must differ/);
    expect(
      resolveScreenProxySecret({
        NODE_ENV: "test",
        SCREEN_PROXY_SECRET: "screen-only",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("screen-only");
    expect(() =>
      resolveScreenProxySecret({
        NODE_ENV: "test",
        SCREEN_PROXY_SECRET: "supervisor-only",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "test",
        SANDBOX_SUPERVISOR_TOKEN: "screen-only",
        SCREEN_PROXY_SECRET: "screen-only",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      resolveSupervisorToken({
        NODE_ENV: "production",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("requires the updater to use a dedicated token", () => {
    expect(() =>
      resolveUpdaterToken({ NODE_ENV: "test", BETTER_AUTH_SECRET: "custom-auth" }),
    ).toThrow(/RAKAZO_UPDATER_TOKEN/);
    expect(
      resolveUpdaterToken({
        NODE_ENV: "test",
        RAKAZO_UPDATER_TOKEN: "updater-only",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toBe("updater-only");
    expect(() =>
      resolveUpdaterToken({
        NODE_ENV: "test",
        RAKAZO_UPDATER_TOKEN: "custom-auth",
        BETTER_AUTH_SECRET: "custom-auth",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      resolveUpdaterToken({
        NODE_ENV: "test",
        RAKAZO_UPDATER_TOKEN: "supervisor-only",
        SANDBOX_SUPERVISOR_TOKEN: "supervisor-only",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      resolveUpdaterToken({
        NODE_ENV: "test",
        RAKAZO_UPDATER_TOKEN: "screen-only",
        SCREEN_PROXY_SECRET: "screen-only",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      resolveUpdaterToken({
        NODE_ENV: "production",
        RAKAZO_UPDATER_TOKEN: "too-short",
      }),
    ).toThrow(/at least 32 characters/);
  });

  it("compares raw strings in constant time", () => {
    expect(timingSafeStringEqual("secret-token", "secret-token")).toBe(true);
    expect(timingSafeStringEqual("secret-token-longer", "secret-token")).toBe(false);
    expect(timingSafeStringEqual("secret-toke", "secret-token")).toBe(false);
    expect(timingSafeStringEqual("Secret-token", "secret-token")).toBe(false);
    expect(timingSafeStringEqual(undefined, "secret-token")).toBe(false);
    expect(timingSafeStringEqual("", "")).toBe(true);
  });

  it("compares bearer tokens without leaking a length or a prefix match", () => {
    expect(hasValidBearerToken("Bearer secret-token", "secret-token")).toBe(true);
    expect(hasValidBearerToken("bearer secret-token", "secret-token")).toBe(true);
    expect(hasValidBearerToken("BEARER secret-token", "secret-token")).toBe(true);
    expect(hasValidBearerToken("bEaReR secret-token", "secret-token")).toBe(true);
    expect(hasValidBearerToken("bearer Secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearer secret-token-longer", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearer secret-toke", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearersecret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearer  secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Bearer\tsecret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken("Basic secret-token", "secret-token")).toBe(false);
    expect(hasValidBearerToken(undefined, "secret-token")).toBe(false);
  });
});

describe("resolveContentEncryption", () => {
  it("defaults to on for servers and tests, off for local development", () => {
    expect(resolveContentEncryption({ NODE_ENV: "production" })).toBe(true);
    expect(resolveContentEncryption({})).toBe(true);
    expect(resolveContentEncryption({ NODE_ENV: "test" })).toBe(true);
    expect(resolveContentEncryption({ NODE_ENV: "development" })).toBe(false);
    expect(
      resolveContentEncryption({ NODE_ENV: "production", RAKAZO_ALLOW_DEV_SECRETS: "1" }),
    ).toBe(false);
  });

  it("follows an explicit setting in every mode", () => {
    expect(resolveContentEncryption({ NODE_ENV: "development", CONTENT_ENCRYPTION: "on" })).toBe(
      true,
    );
    expect(resolveContentEncryption({ NODE_ENV: "production", CONTENT_ENCRYPTION: "off" })).toBe(
      false,
    );
    expect(resolveContentEncryption({ CONTENT_ENCRYPTION: " OFF " })).toBe(false);
    expect(resolveContentEncryption({ NODE_ENV: "development", CONTENT_ENCRYPTION: "" })).toBe(
      false,
    );
  });

  it("rejects anything but on or off", () => {
    for (const value of ["true", "1", "yes", "disabled"])
      expect(() => resolveContentEncryption({ CONTENT_ENCRYPTION: value })).toThrow(
        'CONTENT_ENCRYPTION must be "on" or "off".',
      );
  });
});
