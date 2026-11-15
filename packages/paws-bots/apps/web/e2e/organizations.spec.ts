import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

type OrganizationList = {
  organizations: Array<{ id: string; name: string; defaultSpaceId: string }>;
};

test.afterEach(async ({ page }) => {
  // Not "wait": a handler whose fulfill() lost a race to the route teardown never settles,
  // and "wait" would then hang the test to its timeout.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

function selectedSpace(page: Page) {
  return page.evaluate(() => window.localStorage.getItem("rakazo:space-id"));
}

async function openAvatarMenu(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings" })).toBeVisible();
  return menu;
}

/** Resolves once a chat other than `leaving` is open, outside settings. */
function chatOpened(page: Page, leaving: string) {
  return page.waitForURL(
    (url) =>
      /^\/app\/[^/]+$/.test(url.pathname) &&
      url.pathname !== leaving &&
      !url.searchParams.has("settings"),
  );
}

async function switchFromAvatarMenu(page: Page, name: string, spaceId: string) {
  const leaving = new URL(page.url()).pathname;
  const menu = await openAvatarMenu(page);
  await menu.getByRole("button", { name, exact: true }).click();
  await chatOpened(page, leaving);
  expect(await selectedSpace(page)).toBe(spaceId);
}

test("create, switch, rename and delete an organization", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `organizations-${stamp}@rakazo.test`, "password12", "Org Owner");
  await completeOnboarding(page);

  // One organization: the menu lists none, and creating one lives in settings.
  let menu = await openAvatarMenu(page);
  await expect(menu.getByRole("button", { name: "Personal", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "org-menu-single");
  await page.keyboard.press("Escape");

  let settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-organization").click();
  await expect(
    settings
      .getByTestId("organization-settings")
      .getByRole("button", { name: "Delete organization" }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "org-settings-single");
  await settings.getByRole("button", { name: "Create organization" }).click();
  const create = page.getByRole("dialog", { name: "Create organization" });
  await create.getByLabel("Name").fill("Work");
  await captureScreenshot(page, testInfo, "org-create-dialog");

  // Hold the new organization on onboarding's model step so its account menu can be seen.
  // The rewrites are tracked so they can be finished before interception stops: waiting on
  // Playwright's own bookkeeping can hang when a fulfill() loses a race to the teardown.
  let holdModelStep = true;
  const rewrites = new Set<Promise<void>>();
  await page.route("**/rpc/me", (route) => {
    if (!holdModelStep) return route.fallback();
    const rewrite = (async () => {
      try {
        const response = await route.fetch();
        const body = (await response.json()) as { json: Record<string, unknown> };
        await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
      } catch {
        await route.abort().catch(() => {});
      }
    })();
    rewrites.add(rewrite);
    return rewrite.finally(() => rewrites.delete(rewrite));
  });
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();

  const { organizations } = await rpc<OrganizationList>(page, "organizations/list", {});
  const personal = organizations.find((organization) => organization.name === "Personal")!;
  const work = organizations.find((organization) => organization.name === "Work")!;
  expect(organizations).toHaveLength(2);
  expect(await selectedSpace(page)).toBe(work.defaultSpaceId);

  await page.getByTestId("account-menu").click();
  await expect(page.getByRole("menuitemradio", { name: "Work" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("menuitemradio", { name: "Personal" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await captureScreenshot(page, testInfo, "org-account-menu-onboarding");
  holdModelStep = false;
  await Promise.all([...rewrites]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.getByRole("menuitemradio", { name: "Personal" }).click();
  await chatOpened(page, "");
  expect(await selectedSpace(page)).toBe(personal.defaultSpaceId);

  // Two organizations: both are listed, the active one checked.
  menu = await openAvatarMenu(page);
  await expect(menu.getByRole("button", { name: "Personal", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(menu.getByRole("button", { name: "Work", exact: true })).not.toHaveAttribute(
    "aria-current",
    "true",
  );
  await captureScreenshot(page, testInfo, "org-menu-two-orgs");
  await page.keyboard.press("Escape");

  // Work has no bot yet, so its first visit finishes onboarding there.
  await switchFromAvatarMenu(page, "Work", work.defaultSpaceId);
  const workChat = new URL(page.url()).pathname;
  await switchFromAvatarMenu(page, "Personal", personal.defaultSpaceId);

  // A link to a chat in another organization opens it there.
  await page.goto(workChat);
  await expect.poll(() => selectedSpace(page)).toBe(work.defaultSpaceId);
  await expect(page).toHaveURL((url) => url.pathname === workChat);

  settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-organization").click();
  const organization = settings.getByTestId("organization-settings");
  const name = organization.getByLabel("Name");
  await expect(name).toHaveValue("Work");
  await captureScreenshot(page, testInfo, "org-settings");
  await name.fill("Acme");
  await name.press("Enter");
  await expect
    .poll(async () =>
      (await rpc<OrganizationList>(page, "organizations/list", {})).organizations.map(
        (item) => item.name,
      ),
    )
    .toEqual(["Personal", "Acme"]);

  await organization.getByRole("button", { name: "Delete organization" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Acme?" });
  const remove = confirm.getByRole("button", { name: "Delete", exact: true });
  await expect(remove).toBeDisabled();
  await confirm.getByLabel("Type Acme to confirm").fill("acme");
  await expect(remove).toBeDisabled();
  await confirm.getByLabel("Type Acme to confirm").fill("Acme");
  await expect(remove).toBeEnabled();
  await captureScreenshot(page, testInfo, "org-delete-confirm");
  const leaving = new URL(page.url()).pathname;
  await remove.click();
  await chatOpened(page, leaving);
  expect(await selectedSpace(page)).toBe(personal.defaultSpaceId);

  menu = await openAvatarMenu(page);
  await expect(menu.getByRole("button", { name: "Acme", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Personal", exact: true })).toHaveCount(0);
});
