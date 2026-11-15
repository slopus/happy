import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("opening a bot in another space switches in place, without a page reload", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `space-switch-${stamp}@rakazo.test`, "password12", "Space Switcher");
  await completeOnboarding(page);
  const otherSpace = await page.request.post("/rpc/spaces/create", {
    data: { json: { name: "Second space" } },
  });
  const { json: space } = (await otherSpace.json()) as { json: { id: string } };
  const created = await page.request.post("/rpc/bots/create", {
    headers: { "x-rakazo-space-id": space.id },
    data: {
      json: {
        name: "Scout",
        description: "",
        notifyOnFinish: true,
        computerMode: "team",
      },
    },
  });
  expect(created.ok()).toBe(true);
  const { json: scout } = (await created.json()) as { json: { id: string } };
  await page.reload();
  await expect(page.getByRole("button", { name: /Scout/ }).first()).toBeVisible();

  // A reload would drop this marker; an in-place switch keeps it. The observer
  // records any moment the sidebar lost its bots while the screen was not being
  // held by the switch's transition, which is the blank flash people see.
  await page.evaluate(() => {
    const w = window as unknown as { spaceSwitchMarker?: boolean; visibleBlanks?: number };
    w.spaceSwitchMarker = true;
    w.visibleBlanks = 0;
    new MutationObserver(() => {
      const sidebar = document.querySelector('[data-testid="bots-sidebar"]');
      const held = document.documentElement.classList.contains("rk-space-switching");
      if (!sidebar?.textContent?.includes("Scout") && !held) w.visibleBlanks! += 1;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByRole("button", { name: /Scout/ }).first().click();
  await page.waitForURL(`**/app/${scout.id}`);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { spaceSwitchMarker?: boolean }).spaceSwitchMarker,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { visibleBlanks?: number }).visibleBlanks),
  ).toBe(0);
  expect(await page.evaluate(() => window.localStorage.getItem("rakazo:space-id"))).toBe(space.id);
  await captureScreenshot(page, testInfo, "space-switch-in-place");
});
