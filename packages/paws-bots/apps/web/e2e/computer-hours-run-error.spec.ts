import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { BillingStatus } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

function billingStatus(overrides: Partial<BillingStatus>): BillingStatus {
  return {
    access: true,
    canManage: true,
    trialAvailable: false,
    trialDays: 7,
    state: "active",
    price: { amount: 1500, currency: "usd", interval: "month", intervalCount: 1 },
    seats: 1,
    trialEndsAt: null,
    currentPeriodEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    cancelAtPeriodEnd: false,
    hasCustomer: true,
    funding: "byok",
    byokPriceCents: 1500,
    computerHoursLeft: 0,
    ...overrides,
  };
}

async function enableBilling(route: Route, path: "me" | "bootstrap") {
  const response = await route.fetch();
  const body = (await response.json()) as { json?: Record<string, unknown> };
  const me = path === "me" ? body.json : (body.json?.me as Record<string, unknown> | undefined);
  if (me) me.billingEnabled = true;
  await route.fulfill({ response, json: body });
}

const plans = [
  {
    name: "trial",
    status: { state: "trialing", trialEndsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    summary: "Your trial's computer hours are used up.",
    action: "Start plan now",
  },
  {
    name: "plan",
    status: {},
    summary: "This month's computer hours are used up.",
    action: "Upgrade",
  },
] as const;

for (const plan of plans) {
  test(`a run out of computer hours on the ${plan.name} says why and opens billing`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `computer-hours-${plan.name}-${Date.now()}@rakazo.test`,
      "password12",
      "Hours Out",
    );
    await completeOnboarding(page);
    await page.route("**/api/auth/capabilities", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), billing: true } });
    });
    await page.route("**/rpc/me", (route) => enableBilling(route, "me"));
    await page.route("**/rpc/bootstrap", (route) => enableBilling(route, "bootstrap"));
    const status = billingStatus(plan.status);
    await page.route("**/rpc/billing/status", (route) => route.fulfill({ json: { json: status } }));
    // The scripted runtime fails the run; the snapshot reports it as the computer allowance would.
    await page.route("**/rpc/threads/get", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json?: { run?: { error?: string | null } } };
      if (body.json?.run?.error) body.json.run.error = "No computer hours left.";
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");

    await page.getByPlaceholder(/^Message /).fill("fail this run");
    await page.getByRole("button", { name: "Send" }).click();
    const error = page.getByTestId("composer-error");
    await expect(error).toContainText(plan.summary, { timeout: 30_000 });
    await captureScreenshot(page, testInfo, `computer-hours-out-${plan.name}`);

    const action = error.getByTestId("composer-error-action");
    await expect(action).toHaveText(plan.action);
    await action.click();
    const settings = page.getByTestId("user-settings");
    await expect(settings).toHaveAttribute("data-settings-section", "billing");
    await expect(settings.getByText("Computer hours left", { exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, `computer-hours-out-${plan.name}-billing`);
  });
}
