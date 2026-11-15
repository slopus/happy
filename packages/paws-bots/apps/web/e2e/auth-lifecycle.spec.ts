import type { Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  openEmailSignIn,
  signup,
  signupThroughForm,
} from "./helpers";

test(
  "sign-up stays blank until session and sign-in options are ready",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    let releaseSession = () => {};
    let releaseCapabilities = () => {};
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const capabilitiesReady = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    await page.route("**/api/auth/get-session**", async (route) => {
      await sessionReady;
      await route.fulfill({ json: null });
    });
    await page.route("**/api/auth/capabilities", async (route) => {
      await capabilitiesReady;
      await route.fulfill({
        json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
      });
    });

    await page.goto("/sign-up");
    await expect(page.locator('[data-rakazo-app-state="session-pending"]')).toBeVisible();
    await expect(page.locator("#root")).toHaveText("");
    await captureScreenshot(page, testInfo, "signup-session-pending");

    const capabilitiesRequested = page.waitForRequest("**/api/auth/capabilities");
    releaseSession();
    await capabilitiesRequested;
    await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
    await expect(page.locator("#root")).toHaveText("");
    await captureScreenshot(page, testInfo, "signup-options-pending");

    releaseCapabilities();
    await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "signup-ready");
  },
);
test("signup suggests a fix for a mistyped email domain", async ({ page }, testInfo) => {
  let signups = 0;
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
    }),
  );
  await page.route("**/api/auth/sign-up/email", (route) => {
    signups += 1;
    return route.fulfill({
      json: { token: null, user: { id: "pending-user", emailVerified: false } },
    });
  });
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Typo User");
  await page.getByLabel("Email").fill("typo@gmial.com");
  await page.getByLabel("Password", { exact: true }).fill("password12");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const fix = page.getByRole("button", { name: "typo@gmail.com" });
  await expect(fix).toBeVisible();
  expect(signups).toBe(0);
  await captureScreenshot(page, testInfo, "signup-email-typo");
  await fix.click();
  await expect(page.getByLabel("Email")).toHaveValue("typo@gmail.com");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(signups).toBe(1);
});

test(
  "restricted signup waits for mailbox verification",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
    await page.route("**/api/auth/capabilities", (route) =>
      route.fulfill({
        json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
      }),
    );
    await page.route("**/api/auth/sign-up/email", (route) =>
      route.fulfill({
        json: { token: null, user: { id: "pending-user", emailVerified: false } },
      }),
    );
    await page.goto("/sign-up");
    await page.getByLabel("Name").fill("Pending User");
    await page.getByLabel("Email").fill("pending@example.test");
    await page.getByLabel("Password", { exact: true }).fill("password12");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up\?verify=email$/);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await captureScreenshot(page, testInfo, "signup-verification-required");
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  },
);

test(
  "a new visitor opening the app lands on sign up, fits a narrow phone, and can switch to sign in",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
    await page.route("**/api/auth/capabilities", (route) =>
      route.fulfill({
        json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
      }),
    );
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-up$/);
    await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
    await captureScreenshot(page, testInfo, "logged-out-sign-up-phone");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  },
);

test("a deactivated account's sign-in says so", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  // Where a refused SSO sign-in lands; password and code sign-in show the same text.
  await page.goto("/sign-in?error=ACCOUNT_DEACTIVATED");
  await expect(page.getByText("This account is deactivated")).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-account-deactivated");
});

test("an unknown page offers a way home", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await captureScreenshot(page, testInfo, "not-found");
  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
});

test("logout protects bot deep links and sign-in restores the session", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const email = `auth-lifecycle-${stamp}@rakazo.test`;
  const password = "password12";
  const userName = "Auth Lifecycle";

  await page.goto("/sign-up");
  await openEmailSignIn(page);
  await expect(page.getByLabel("Name")).toHaveAttribute("autocomplete", "name");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "new-password",
  );

  await signupThroughForm(page, email, password, userName);
  await completeOnboarding(page);

  await page.waitForURL(/\/app\/[^/]+$/);
  const protectedBotPath = new URL(page.url()).pathname;
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await captureScreenshot(page, testInfo, "36-account-menu");

  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ status: 500, body: "" }), {
    times: 1,
  });
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not log out. Try again." }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "36-account-menu-logout-error");
  await page.unroute("**/api/auth/sign-out");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Sign-out usually overlaps a bot refresh that the server rejects; wait for every
  // refresh that started so an unhandled rejection would surface before the assertion.
  const refreshes: Promise<unknown>[] = [];
  const trackRefresh = (request: Request) => {
    if (request.url().includes("/rpc/spaces/list")) refreshes.push(request.response());
  };
  page.on("request", trackRefresh);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  page.off("request", trackRefresh);
  await Promise.all(refreshes);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  expect(pageErrors).toEqual([]);
  // Someone who has signed in here before reopens the app to sign in, not to a new account.
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await captureScreenshot(page, testInfo, "37-logged-out-returning");

  await page.goto(protectedBotPath);
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByText("Chief", { exact: true })).toHaveCount(0);
  await expect(page.getByText(userName, { exact: true })).toHaveCount(0);
  await openEmailSignIn(page);
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username webauthn");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await captureScreenshot(page, testInfo, "38-protected-deep-link-sign-in");

  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("wrong-password12");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page
      .locator("form")
      .getByText(/invalid email or password|invalid credentials|incorrect password/i),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await captureScreenshot(page, testInfo, "39-invalid-credentials");

  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === protectedBotPath, {
    timeout: 20_000,
  });
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await expect(composer).toHaveAttribute("name", "chat-message");
  await expect(composer).toHaveAttribute("autocomplete", "off");
  await expect(composer).toHaveAttribute("aria-label", "Message Chief");
  await expect(page.getByRole("button", { name: new RegExp(userName, "i") })).toBeVisible();

  await composer.fill("line one");
  const heightBeforeNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  await composer.press("Shift+Enter");
  await composer.type("line two");
  await expect(composer).toHaveValue("line one\nline two");
  const heightWithNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  expect(heightWithNewline).toBeGreaterThan(heightBeforeNewline);

  await composer.press("Enter");
  const multilineMessage = page
    .getByTestId("transcript")
    .getByText("line one\nline two", { exact: true });
  await expect(multilineMessage).toBeVisible();
  await expect(multilineMessage).toHaveCSS("white-space", "pre-wrap");

  const message = "Fake composer regression check.";
  await composer.fill(message);
  // The transcript is optimistic; wait for the previous send to finish before
  // testing Enter again, just as the enabled Send control requires.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "40-restored-auth-session");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  // Scope to the transcript: the sidebar activity row can echo the same text.
  await expect(page.getByTestId("transcript").getByText(message, { exact: true })).toBeVisible();
});

test("changes and recovers an email password", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const email = `password-recovery-${stamp}@rakazo.test`;
  const originalPassword = "password12";
  const changedPassword = "changed-password12";
  const resetPassword = "reset-password12";
  const userName = "Password Recovery";

  await signup(page, email, originalPassword, userName);
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("sidebar-search-trigger").click();
  await expect(page.getByTestId("sidebar-search").locator("input")).toHaveAttribute(
    "autocomplete",
    "off",
  );
  await expect(page.getByTestId("sidebar-search").locator("input")).toHaveAttribute(
    "name",
    "sidebar-search",
  );

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Current password")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "general-settings");
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(settings.locator('input[name="username"]')).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await expect(settings.locator('input[name="username"]')).toHaveValue(email);
  await expect(settings.getByLabel("Current password")).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await expect(settings.getByLabel("New password")).toHaveAttribute("autocomplete", "new-password");
  await expect(settings.getByLabel("New password")).toHaveAttribute("minlength", "8");
  await expect(settings.getByLabel("Current password")).not.toHaveAttribute("minlength");
  await expect(settings.getByLabel("Confirm password")).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await settings.getByLabel("Current password").fill(originalPassword);
  await settings.getByLabel("New password").fill(changedPassword);
  await settings.getByLabel("Confirm password").fill(changedPassword);
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByText("Password updated")).toBeVisible();
  await expect(settings.getByLabel("Current password")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "41-password-changed");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await openEmailSignIn(page);
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reset your password" })).not.toBeVisible();
  await captureScreenshot(page, testInfo, "42-password-reset-requested");

  const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";
  // Workers share one outbox, so read only this user's mail.
  const sentToUser = async () => {
    const response = await page.request.get(`${emailApi}/__e2e/emails`);
    expect(response.headers()["cache-control"]).toBe("no-store");
    const messages = (await response.json()) as Array<{
      to: string;
      subject: string;
      text: string;
      html: string;
    }>;
    return messages.filter(
      (message) => message.to === email && message.subject === "Reset your Rakazo password",
    );
  };
  await expect.poll(async () => (await sentToUser()).length).toBeGreaterThan(0);
  const resetMessage = (await sentToUser()).at(-1)!;
  const resetUrl = resetMessage.text.match(/https?:\/\/\S+/)?.[0];
  expect(resetUrl).toBeTruthy();

  const emailPreview = await page.context().newPage();
  try {
    await emailPreview.setContent(resetMessage.html);
    const resetLink = emailPreview.getByRole("link", { name: "Reset password", exact: true });
    await expect(resetLink).toHaveAttribute("href", resetUrl!);
    for (const width of [800, 390]) {
      await emailPreview.setViewportSize({ width, height: 480 });
      await expect(resetLink).toBeVisible();
      expect(
        await emailPreview.locator("body").evaluate((body) => body.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await captureScreenshot(emailPreview, testInfo, `password-reset-email-${width}`);
    }
  } finally {
    await emailPreview.close();
  }

  await page.goto(resetUrl!);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password").fill(resetPassword);
  await page.getByLabel("Confirm password").fill(resetPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await openEmailSignIn(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
});
