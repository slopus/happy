import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { BillingStatus } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

const price = { amount: 1200, currency: "usd", interval: "month", intervalCount: 1 } as const;

function billingStatus(overrides: Partial<BillingStatus>): BillingStatus {
  return {
    access: false,
    canManage: true,
    trialAvailable: true,
    trialDays: 7,
    state: "none",
    price,
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    hasCustomer: false,
    ...overrides,
  };
}

const tiers: NonNullable<BillingStatus["byokTiers"]> = [
  {
    tier: "standard",
    name: "Standard",
    monthlyPriceCents: 1500,
    annualPriceCents: 14400,
    computerSize: "standard",
    computerHours: 25,
  },
  {
    tier: "pro",
    name: "Pro",
    monthlyPriceCents: 4900,
    annualPriceCents: 46800,
    computerSize: "large",
    computerHours: 100,
  },
  {
    tier: "max",
    name: "Max",
    monthlyPriceCents: 9900,
    annualPriceCents: 94800,
    computerSize: "xlarge",
    computerHours: 200,
  },
];

async function enableBilling(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) me.billingEnabled = true;
  await route.fulfill({ response, json: body });
}

test("choose your own key or monthly credits, then add a one-time top-up", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `credit-choice-${stamp}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  let status = billingStatus({
    creditPurchasesEnabled: true,
    byokPriceCents: 1000,
    funding: null,
    balanceUsd: 0,
    monthlyAmountCents: null,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose how to use Rakazo" })).toBeVisible();
  await expect(page.getByText("$10 / month", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Works with your ChatGPT or Claude plan.", { exact: true }),
  ).toBeVisible();
  // Only the own-key plan has a trial; credits are resold at cost.
  await expect(
    page.getByRole("button", { name: "Start 7-day free trial", exact: true }),
  ).toBeVisible();
  const planSelect = page.getByRole("combobox", { name: "Monthly credits" });
  await expect(planSelect).toHaveCSS("height", "48px");
  await expect(planSelect).toContainText("$30 / month");
  await planSelect.click();
  const options = page.locator('[data-slot="select-content"]');
  await expect
    .poll(async () => {
      const [trigger, menu] = await Promise.all([planSelect.boundingBox(), options.boundingBox()]);
      return trigger && menu ? Math.abs(trigger.width - menu.width) : 999;
    })
    .toBeLessThanOrEqual(2);
  const triggerBox = await planSelect.boundingBox();
  const optionsBox = await options.boundingBox();
  expect(optionsBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
  await captureScreenshot(page, testInfo, "billing-credit-options");
  await page.keyboard.press("Escape");
  await expect(page.getByText("All $30 goes to model usage.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-credit-choice");
  // Leaving before choosing a plan: log out or delete the account, without reaching settings.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-account-menu");
  // A log out the server rejects reports the log-out failure, not a billing error.
  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ status: 500, body: "" }), {
    times: 1,
  });
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not log out. Try again." }),
  ).toBeVisible();
  await page.unroute("**/api/auth/sign-out");
  // The failed log out reloaded the page; reopen the menu to reach deletion.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete account" }).click();
  const deletion = page.getByRole("dialog", { name: "Delete account" });
  await expect(deletion.getByLabel("Current password")).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-delete-account");
  await page.keyboard.press("Escape");
  await expect(deletion).toHaveCount(0);
  let purchase: { amountCents: number; monthly: boolean } | undefined;
  await page.route("**/rpc/billing/purchaseCredits", async (route) => {
    purchase = route.request().postDataJSON().json;
    status = billingStatus({
      access: true,
      creditPurchasesEnabled: true,
      funding: "credits",
      balanceUsd: 30,
      monthlyAmountCents: 3000,
      state: "active",
      hasCustomer: true,
      price: { ...price, amount: 3000 },
      computerHoursLeft: 13,
    });
    await route.fulfill({ json: { json: { url: new URL("/app", page.url()).href } } });
  });
  await page.getByRole("button", { name: "Subscribe to credits", exact: true }).click();
  await expect(page.getByText("Chief").first()).toBeVisible();
  expect(purchase).toEqual({ amountCents: 3000, monthly: true });
  const settings = await openUserSettings(page, "billing");
  await expect(settings.getByText("$30.00", { exact: true })).toBeVisible();
  await expect(settings.getByText("Computer hours left", { exact: true })).toBeVisible();
  await expect(settings.getByText("13", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-credit-balance");
  await settings.getByRole("button", { name: "Add credits", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add credits" });
  await expect(dialog.getByRole("combobox", { name: "Credit amount" })).toHaveCSS("height", "48px");
  await dialog.getByRole("combobox", { name: "Credit amount" }).click();
  await page.getByRole("option", { name: "$50", exact: true }).click();
  await captureScreenshot(page, testInfo, "billing-add-credits");
  await Promise.all([
    page.waitForEvent("load"),
    dialog.getByRole("button", { name: "Continue to checkout" }).click(),
  ]);
  await expect(page.getByText("Chief").first()).toBeVisible();
  expect(purchase).toEqual({ amountCents: 5000, monthly: false });

  status = billingStatus({
    creditPurchasesEnabled: true,
    funding: null,
    balanceUsd: 0,
    monthlyAmountCents: null,
  });
  await page.reload();
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    status = billingStatus({
      access: true,
      creditPurchasesEnabled: true,
      funding: "byok",
      balanceUsd: 0,
      monthlyAmountCents: null,
    });
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.getByRole("button", { name: "Connect my own", exact: true }).click();
  await expect(page.getByText("Chief").first()).toBeVisible();

  status = billingStatus({
    access: true,
    trialAvailable: false,
    creditPurchasesEnabled: true,
    byokPriceCents: 1000,
    byokFreeUntil: "2030-01-15T12:00:00.000Z",
    funding: "byok",
    balanceUsd: 0,
    monthlyAmountCents: null,
  });
  await page.reload();
  await expect(page.getByText("Free plan ends Jan 15, 2030", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "sidebar-free-plan-ends");
  await page.getByRole("button", { name: "Upgrade", exact: true }).click();
  const plans = page.getByRole("dialog", { name: "Choose how to use Rakazo" });
  await expect(plans.getByText("$10 / month", { exact: true })).toBeVisible();
  await expect(
    plans.getByRole("button", { name: "Subscribe with your own AI", exact: true }),
  ).toBeVisible();
  await expect(plans.getByRole("button", { name: "Account", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]plans/);
  await captureScreenshot(page, testInfo, "billing-upgrade-plans");
  await page.keyboard.press("Escape");
  await expect(plans).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]plans/);
  await expect(page.getByText("Chief").first()).toBeVisible();

  await page.goto("/app?plans");
  // The bare route redirects to the first chat and keeps the link's `plans` param.
  await expect(page).toHaveURL(/\/app\/[^/?]+\?plans$/);
  await expect(plans).toBeVisible();
  let selectedFunding = false;
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    selectedFunding = true;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.route("**/rpc/billing/checkout", (route) =>
    route.fulfill({ json: { json: { url: new URL("/app?paid", page.url()).href } } }),
  );
  await Promise.all([
    page.waitForURL(/[?&]paid/),
    plans.getByRole("button", { name: "Subscribe with your own AI", exact: true }).click(),
  ]);
  expect(selectedFunding).toBe(false);
  await page.unroute("**/rpc/billing/selectFunding");
  await expect(page.getByText("Chief").first()).toBeVisible();
  const freePlan = await openUserSettings(page, "billing");
  await expect(
    freePlan.getByText("Using your API key. Free plan ends Jan 15, 2030.", { exact: true }),
  ).toBeVisible();
  await expect(
    freePlan.getByRole("button", { name: "Subscribe for $10 / month", exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-free-plan-ends");
  await page.keyboard.press("Escape");

  status = billingStatus({
    access: true,
    creditPurchasesEnabled: true,
    funding: "byok",
    balanceUsd: 12,
    monthlyAmountCents: null,
  });
  await page.reload();
  const existingCredits = await openUserSettings(page, "billing");
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    expect(route.request().postDataJSON().json).toEqual({ funding: "credits" });
    status = { ...status, funding: "credits" };
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await captureScreenshot(page, testInfo, "billing-use-existing-credits");
  // Switching reloads the page; the URL keeps Billing open to show the result.
  await existingCredits.getByRole("button", { name: "Use Rakazo credits", exact: true }).click();
  const reactivated = page.getByTestId("user-settings");
  await expect(reactivated).toHaveAttribute("data-settings-section", "billing");
  await expect(reactivated.getByText("$12.00", { exact: true })).toBeVisible();
  await expect(
    reactivated.getByRole("button", { name: "Use Rakazo credits", exact: true }),
  ).toHaveCount(0);
  expect(purchase).toEqual({ amountCents: 5000, monthly: false });
});

test("delete an unpaid organization from the plan choice", async ({ page }, testInfo) => {
  await signup(page, `org-paywall-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  const work = await rpc<{ id: string; defaultSpaceId: string }>(page, "organizations/create", {
    name: "Work",
  });
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  // Only the new organization is unpaid.
  await page.route("**/rpc/billing/status", async (route) => {
    const unpaid = route.request().headers()["x-rakazo-space-id"] === work.defaultSpaceId;
    await route.fulfill({
      json: { json: billingStatus(unpaid ? {} : { access: true, state: "active" }) },
    });
  });
  await page.evaluate(
    (spaceId) => window.localStorage.setItem("rakazo:space-id", spaceId),
    work.defaultSpaceId,
  );
  await page.reload();
  await expect(page.getByTestId("billing-paywall")).toBeVisible();

  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete organization" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Work?" });
  await confirm.getByLabel("Type Work to confirm").fill("Work");
  await captureScreenshot(page, testInfo, "billing-delete-organization");
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Chief").first()).toBeVisible();
  const { organizations } = await rpc<{ organizations: Array<{ name: string }> }>(
    page,
    "organizations/list",
    {},
  );
  expect(organizations.map((organization) => organization.name)).toEqual(["Personal"]);
});

test("start the own-key plan billed yearly", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `byok-yearly-${stamp}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  const status = billingStatus({
    creditPurchasesEnabled: true,
    byokPriceCents: 1500,
    byokAnnualPriceCents: 14400,
    funding: null,
    balanceUsd: 0,
    monthlyAmountCents: null,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();
  const period = page.getByRole("group", { name: "Billing period" });
  await expect(page.getByText("$15", { exact: true })).toBeVisible();
  await period.getByRole("button", { name: /Yearly/ }).click();
  await expect(page.getByText("$12", { exact: true })).toBeVisible();
  await expect(period.getByText("−20%", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-byok-yearly");
  let selected: unknown;
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    selected = route.request().postDataJSON().json;
    await route.fulfill({ json: { json: { url: new URL("/app?paid", page.url()).href } } });
  });
  await Promise.all([
    page.waitForURL(/[?&]paid/),
    page.getByRole("button", { name: "Start 7-day free trial", exact: true }).click(),
  ]);
  // The checkout is mocked, so the paywall returns; waiting lets the reload's requests settle.
  await expect(page.getByRole("heading", { name: "Choose how to use Rakazo" })).toBeVisible();
  expect(selected).toEqual({ funding: "byok", interval: "year" });
});

test("start a bigger tier's trial from the tiers layout", async ({ page }, testInfo) => {
  await signup(page, `plan-tiers-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  const status = billingStatus({
    creditPurchasesEnabled: true,
    byokPriceCents: 1500,
    byokAnnualPriceCents: 14400,
    byokTiers: tiers,
    planLayout: "tiers",
    funding: null,
    balanceUsd: 0,
    monthlyAmountCents: null,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Max" })).toBeVisible();
  await expect(page.getByText("A 2× more powerful computer for your bot")).toBeVisible();
  await expect(page.getByText("$49", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Monthly credits" })).toContainText(
    "$30 / month",
  );
  await captureScreenshot(page, testInfo, "billing-plan-tiers");
  let selected: unknown;
  await page.route("**/rpc/billing/selectFunding", async (route) => {
    selected = route.request().postDataJSON().json;
    await route.fulfill({ json: { json: { url: new URL("/app?paid", page.url()).href } } });
  });
  await page
    .getByRole("group", { name: "Billing period" })
    .getByRole("button", { name: /Yearly/ })
    .click();
  await expect(page.getByText("$39", { exact: true })).toBeVisible();
  await Promise.all([
    page.waitForURL(/[?&]paid/),
    page.getByRole("button", { name: "Start Pro trial", exact: true }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Choose how to use Rakazo" })).toBeVisible();
  expect(selected).toEqual({ funding: "byok", interval: "year", tier: "pro" });
});

test("end an own-key trial early to get full computer hours", async ({ page }, testInfo) => {
  await signup(page, `trial-end-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  const trial = billingStatus({
    access: true,
    trialAvailable: false,
    creditPurchasesEnabled: true,
    byokPriceCents: 1000,
    funding: "byok",
    balanceUsd: 0,
    monthlyAmountCents: null,
    state: "trialing",
    trialEndsAt: "2030-01-15T12:00:00.000Z",
    currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
    hasCustomer: true,
    computerHoursLeft: 4,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: trial } }));
  let ended = false;
  await page.route("**/rpc/billing/endTrial", async (route) => {
    ended = true;
    await route.fulfill({
      json: { json: { ...trial, state: "active", trialEndsAt: null, computerHoursLeft: 25 } },
    });
  });
  await page.reload();
  const settings = await openUserSettings(page, "billing");
  await expect(
    settings.getByText("Trials get fewer hours to prevent abuse.", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-trial-computer-hours");
  await settings.getByRole("button", { name: "Start plan now", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Start your plan now?" });
  await expect(confirm.getByText(/charged \$10(\.00)? today/)).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-end-trial-confirm");
  await confirm.getByRole("button", { name: "Start plan", exact: true }).click();
  await expect.poll(() => ended).toBe(true);
});

test("a cancelled trial explains its missing computer hours and offers renewal", async ({
  page,
}, testInfo) => {
  await signup(page, `trial-cancelled-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  const trial = billingStatus({
    access: true,
    trialAvailable: false,
    creditPurchasesEnabled: true,
    byokPriceCents: 1000,
    funding: "byok",
    balanceUsd: 0,
    monthlyAmountCents: null,
    state: "trialing",
    cancelAtPeriodEnd: true,
    trialEndsAt: "2030-01-15T12:00:00.000Z",
    currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
    hasCustomer: true,
    computerHoursLeft: 0,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: trial } }));
  let portalOpened = false;
  await page.route("**/rpc/billing/portal", async (route) => {
    portalOpened = true;
    await route.fulfill({ json: { json: { url: "/app" } } });
  });
  await page.reload();
  const settings = await openUserSettings(page, "billing");
  await expect(
    settings.getByText("Cancelled trials have no computer hours.", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("button", { name: "Start plan now" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "billing-cancelled-trial-computer-hours");
  await settings.getByRole("button", { name: "Renew plan", exact: true }).click();
  await expect.poll(() => portalOpened).toBe(true);
});

test("switch a monthly own-key plan to yearly", async ({ page }, testInfo) => {
  await signup(page, `byok-switch-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  let status = billingStatus({
    access: true,
    trialAvailable: false,
    creditPurchasesEnabled: true,
    byokPriceCents: 1500,
    byokInterval: "month",
    byokAnnualPriceCents: 14400,
    funding: "byok",
    balanceUsd: 0,
    monthlyAmountCents: null,
    state: "active",
    currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
    hasCustomer: true,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  let switched = false;
  await page.route("**/rpc/billing/switchToYearly", async (route) => {
    switched = true;
    status = { ...status, byokPriceCents: 14400, byokInterval: "year" };
    await route.fulfill({ json: { json: status } });
  });
  await page.reload();
  const settings = await openUserSettings(page, "billing");
  const plan = settings.getByTestId("own-key-plan");
  await expect(plan.getByText("$15 / month", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-own-key-monthly");
  await plan.getByRole("button", { name: /Switch to yearly/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Switch to yearly?" });
  await expect(confirm.getByText(/charged \$144 today/)).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-switch-to-yearly");
  await confirm.getByRole("button", { name: "Switch", exact: true }).click();
  await expect.poll(() => switched).toBe(true);
  await expect(plan.getByText("$144 / year", { exact: true })).toBeVisible();
  await expect(plan.getByRole("button", { name: /Switch to yearly/ })).toHaveCount(0);
});

test("move an own-key plan to a bigger tier", async ({ page }, testInfo) => {
  await signup(page, `byok-tier-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  let status = billingStatus({
    access: true,
    trialAvailable: false,
    creditPurchasesEnabled: true,
    byokPriceCents: 1500,
    byokInterval: "month",
    byokAnnualPriceCents: 14400,
    byokTier: "standard",
    byokTiers: tiers,
    funding: "byok",
    balanceUsd: 0,
    monthlyAmountCents: null,
    state: "active",
    currentPeriodEndsAt: "2030-01-15T12:00:00.000Z",
    hasCustomer: true,
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  let changedTo: unknown = null;
  await page.route("**/rpc/billing/changeTier", async (route) => {
    changedTo = route.request().postDataJSON()?.json?.tier;
    status = { ...status, byokPriceCents: 4900, byokAnnualPriceCents: 46800, byokTier: "pro" };
    await route.fulfill({ json: { json: status } });
  });
  await page.reload();
  const settings = await openUserSettings(page, "billing");
  const plan = settings.getByTestId("own-key-plan");
  await expect(plan.getByText("4 vCPU, 8 GB, 25 computer hours a month")).toBeVisible();
  await plan.getByRole("combobox", { name: "Plan" }).click();
  await expect(page.getByRole("option", { name: /Max · \$99 \/ month/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-own-key-tiers");
  await page.getByRole("option", { name: /Pro · \$49 \/ month/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Switch to Pro?" });
  await expect(
    confirm.getByText("Your card is charged the prorated difference today."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-own-key-tier-confirm");
  await confirm.getByRole("button", { name: "Switch", exact: true }).click();
  await expect.poll(() => changedTo).toBe("pro");
  await expect(plan.getByText("$49 / month", { exact: true })).toBeVisible();
  await expect(plan.getByText("8 vCPU, 16 GB, 100 computer hours a month")).toBeVisible();
});

test("yearly billing shows the monthly computer reset separately from renewal", async ({
  page,
}, testInfo) => {
  await signup(page, `annual-hours-${Date.now()}@rakazo.test`, "password12", "Demo Customer");
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
  });
  await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
  const status = billingStatus({
    access: true,
    trialAvailable: false,
    funding: "byok",
    byokTier: "max",
    byokPriceCents: 94800,
    byokInterval: "year",
    state: "active",
    hasCustomer: true,
    currentPeriodEndsAt: "2031-01-15T12:00:00.000Z",
    computerHoursLeft: 180,
    computerHoursResetAt: "2030-02-15T12:00:00.000Z",
  });
  await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
  await page.reload();
  const settings = await openUserSettings(page, "billing");
  await expect(settings.getByText("Resets Feb 15, 2030", { exact: true })).toBeVisible();
  await expect(settings.getByText("Renews Jan 15, 2031", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "billing-annual-computer-reset");
});
