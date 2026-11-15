import { expect, it, vi } from "vitest";
import {
  accountSecuritySchema,
  authCapabilitiesSchema,
  IDENTITY_CONFIRMATION_REQUIRED,
  legacyAuthCapabilitiesSchema,
  runWithIdentityConfirmation,
  signInProviderGroups,
  signInProviders,
} from "./auth.js";

it("requires explicit password and SSO capabilities", () => {
  expect(authCapabilitiesSchema.safeParse({ passwordReset: false, resetUrl: null }).success).toBe(
    false,
  );
  expect(
    authCapabilitiesSchema.parse({
      passwordAuth: false,
      passwordReset: false,
      resetUrl: null,
      sso: { name: "SSO", availability: "checking" },
    }).passwordAuth,
  ).toBe(false);
});

it("lists sign-in providers and falls back to the older SSO field", () => {
  const base = { passwordAuth: true, passwordReset: false, resetUrl: null, sso: null };
  expect(signInProviders(authCapabilitiesSchema.parse(base))).toEqual([]);
  expect(
    signInProviders(
      authCapabilitiesSchema.parse({
        ...base,
        sso: { name: "SSO", availability: "available" },
      }),
    ),
  ).toEqual([{ id: "oidc", name: "SSO" }]);
  const providers = [
    { id: "google", name: "Google" },
    { id: "apple", name: "Apple" },
  ];
  expect(signInProviders(authCapabilitiesSchema.parse({ ...base, providers }))).toEqual(providers);
  expect(
    signInProviders(
      authCapabilitiesSchema.parse({
        ...base,
        sso: { name: "SSO", availability: "available" },
        providers: [],
      }),
    ),
  ).toEqual([]);
});

it("treats email code sign-in as an optional boolean capability", () => {
  const base = { passwordAuth: true, passwordReset: true, resetUrl: null, sso: null };
  expect(authCapabilitiesSchema.parse(base).emailCode).toBeUndefined();
  expect(authCapabilitiesSchema.parse({ ...base, emailCode: true }).emailCode).toBe(true);
  expect(authCapabilitiesSchema.safeParse({ ...base, emailCode: "true" }).success).toBe(false);
});

it("only accepts complete legacy capabilities without partial SSO fields", () => {
  expect(
    legacyAuthCapabilitiesSchema.parse({ passwordReset: false, resetUrl: null, billing: true }),
  ).toEqual({ passwordAuth: true, sso: null, passwordReset: false, resetUrl: null, billing: true });
  for (const value of [
    {},
    { passwordReset: false },
    { passwordReset: false, resetUrl: null, passwordAuth: false },
    { passwordReset: false, resetUrl: null, sso: null },
    { passwordReset: "false", resetUrl: null },
  ]) {
    expect(legacyAuthCapabilitiesSchema.safeParse(value).success).toBe(false);
  }
});

it("accepts older account security and explicit password-change policy", () => {
  const security = {
    hasPassword: true,
    freshOidcAuth: false,
    ssoLinked: false,
    emailDeletion: true,
    sso: null,
  };
  expect(accountSecuritySchema.parse(security).passwordChangeEnabled).not.toBe(false);
  expect(
    accountSecuritySchema.parse({ ...security, passwordChangeEnabled: false })
      .passwordChangeEnabled,
  ).toBe(false);
  expect(
    accountSecuritySchema.safeParse({ ...security, passwordChangeEnabled: "false" }).success,
  ).toBe(false);
});

const confirmationRequired = () =>
  Object.assign(new Error("Confirm it's you"), { code: IDENTITY_CONFIRMATION_REQUIRED });

it("runs an action without asking when the server does not require confirmation", async () => {
  const confirm = vi.fn(async () => true);
  await expect(runWithIdentityConfirmation(async () => "value", confirm)).resolves.toBe("value");
  expect(confirm).not.toHaveBeenCalled();
});

it("confirms identity, then retries the action once", async () => {
  const action = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(confirmationRequired())
    .mockResolvedValueOnce("value");
  const confirm = vi.fn(async () => true);
  await expect(runWithIdentityConfirmation(action, confirm)).resolves.toBe("value");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledTimes(2);
});

it("does not ask again when the retry still needs confirmation", async () => {
  const action = vi.fn(async () => {
    throw confirmationRequired();
  });
  const confirm = vi.fn(async () => true);
  await expect(runWithIdentityConfirmation(action, confirm)).rejects.toMatchObject({
    code: IDENTITY_CONFIRMATION_REQUIRED,
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(action).toHaveBeenCalledTimes(2);
});

it("rethrows without retrying when the prompt is dismissed", async () => {
  const action = vi.fn(async () => {
    throw confirmationRequired();
  });
  await expect(runWithIdentityConfirmation(action, async () => false)).rejects.toMatchObject({
    code: IDENTITY_CONFIRMATION_REQUIRED,
  });
  expect(action).toHaveBeenCalledTimes(1);
});

it("passes other failures through without asking", async () => {
  const confirm = vi.fn(async () => true);
  const failure = Object.assign(new Error("Missing"), { code: "NOT_FOUND" });
  await expect(
    runWithIdentityConfirmation(async () => Promise.reject(failure), confirm),
  ).rejects.toBe(failure);
  expect(confirm).not.toHaveBeenCalled();
});

it("keeps SSO prominent alone and secondary alongside personal providers", () => {
  const sso = { id: "oidc", name: "Company" };
  const personal = { id: "personal", name: "Personal" };
  expect(signInProviderGroups([sso])).toEqual({ primary: [sso], secondary: [] });
  expect(signInProviderGroups([sso, personal])).toEqual({ primary: [personal], secondary: [sso] });
  expect(signInProviderGroups([])).toEqual({ primary: [], secondary: [] });
});
