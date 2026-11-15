import { test as base, expect } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openEmailSignIn,
  openUserSettings,
  signup,
} from "./helpers";

// Loopback deployments use the WebAuthn relying party `localhost` (IP hosts cannot hold
// passkeys), so this flow runs on the localhost twin of the configured origin.
const test = base.extend({
  baseURL: async ({ baseURL }, use) => {
    const url = new URL(baseURL ?? "http://127.0.0.1:5173");
    url.hostname = "localhost";
    await use(url.origin);
  },
});

test("adds a passkey after signup and signs in with it", async ({ page }, testInfo) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const email = `passkey-${Date.now()}@example.test`;
  const userName = "Passkey Person";

  await signup(page, email, "password12", userName);
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const offer = page.getByTestId("passkey-offer");
  await expect(offer).toBeVisible();
  await captureScreenshot(page, testInfo, "passkey-offer");
  await offer.getByRole("button", { name: "Add passkey" }).click();
  await expect(offer).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
    )
    .toBe(1);

  const settings = await openUserSettings(page);
  const passkeys = settings.getByTestId("passkey-settings");
  await expect(passkeys.getByRole("listitem")).toHaveCount(1);
  await passkeys.getByRole("button", { name: "Rename" }).click();
  await passkeys.getByRole("textbox", { name: "Rename" }).fill("Work laptop");
  await passkeys.getByRole("button", { name: "Save" }).click();
  await expect(passkeys.getByRole("listitem")).toContainText("Work laptop");
  await passkeys.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "passkey-settings");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  const account = page.getByRole("button", { name: new RegExp(userName, "i") });
  // The virtual authenticator answers browser autofill at once, so signing out lands
  // on a sign-in page that completes through the email field's passkey suggestion.
  const verified = () =>
    page.waitForResponse(
      (response) => response.url().includes("/passkey/verify-authentication") && response.ok(),
    );
  let signedIn = verified();
  await account.click();
  await page.getByRole("button", { name: "Log out" }).click();
  await signedIn;
  await expect(account).toBeVisible();
  await expect(page.getByTestId("passkey-offer")).toHaveCount(0);

  // Without a touch, autofill waits, and the button signs in.
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
  await account.click();
  await page.getByRole("button", { name: "Log out" }).click();
  await openEmailSignIn(page);
  const signIn = page.getByRole("button", { name: "Sign in with passkey" });
  await expect(signIn).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username webauthn");
  await captureScreenshot(page, testInfo, "passkey-sign-in");
  // Listen first: the pending autofill request may answer as soon as presence returns.
  signedIn = verified();
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: true });
  await signIn.click();
  await signedIn;
  await page.waitForURL(/\/app/);
  await expect(account).toBeVisible();

  // With a provider configured, sign-in opens on the chooser, which offers the passkey itself.
  await page.route("**/api/auth/capabilities", async (route) => {
    const capabilities = await (await route.fetch()).json();
    await route.fulfill({
      json: { ...capabilities, providers: [{ id: "google", name: "Google" }] },
    });
  });
  await account.click();
  await page.getByRole("button", { name: "Log out" }).click();
  const choice = page.getByRole("button", { name: /^Continue with passkey/ });
  await expect(choice).toBeVisible();
  await expect(choice).toContainText("Last used");
  await captureScreenshot(page, testInfo, "passkey-sign-in-chooser");
  signedIn = verified();
  await choice.click();
  await signedIn;
  await page.waitForURL(/\/app/);
  await expect(account).toBeVisible();
});
