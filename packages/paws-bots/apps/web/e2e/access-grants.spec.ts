import { expect, test } from "@playwright/test";
import type { AccessGrant } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, makeAdmin, signup } from "./helpers";

test("an admin grants free access to an email", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const admin = `access-admin-${stamp}@rakazo.test`;
  await signup(page, admin, "password12", `Access Admin ${stamp}`);
  await completeOnboarding(page);

  let grants: AccessGrant[] = [
    {
      id: "grant-qa",
      email: "qa@example.test",
      creditCents: 10_000,
      freeMonths: 0,
      createdBy: admin,
      status: "applied",
      createdAt: "2026-10-01T09:00:00.000Z",
      appliedAt: "2026-10-01T10:00:00.000Z",
    },
  ];
  const created: unknown[] = [];
  await page.route("**/rpc/me", (route) => makeAdmin(route, "me"));
  await page.route("**/rpc/bootstrap", (route) => makeAdmin(route, "bootstrap"));
  await page.route("**/rpc/accessGrants/list", (route) =>
    route.fulfill({ json: { json: grants } }),
  );
  await page.route("**/rpc/accessGrants/create", async (route) => {
    const input = route.request().postDataJSON().json as Pick<
      AccessGrant,
      "email" | "creditCents" | "freeMonths"
    >;
    created.push(input);
    const grant: AccessGrant = {
      ...input,
      id: "grant-new",
      createdBy: admin,
      status: "pending",
      createdAt: "2026-10-02T09:00:00.000Z",
      appliedAt: null,
    };
    grants = [grant, ...grants];
    await route.fulfill({ json: { json: grant } });
  });
  await page.route("**/rpc/accessGrants/revoke", async (route) => {
    grants = grants.map((grant) =>
      grant.id === "grant-new" ? { ...grant, status: "revoked" } : grant,
    );
    await route.fulfill({ json: { json: grants[0] } });
  });

  await page.goto("/admin/access");
  const list = page.getByTestId("access-grants");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  const grant = page.getByRole("button", { name: "Grant", exact: true });
  await page.getByLabel("Email").fill("friend@example.test");
  await expect(grant).toBeDisabled();
  await page.getByLabel("Credits ($)").fill("25");
  await page.getByLabel("Free months").fill("2");
  await grant.click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  expect(created).toEqual([{ email: "friend@example.test", creditCents: 2500, freeMonths: 2 }]);
  const pending = list.getByRole("listitem", { name: "friend@example.test" });
  await expect(pending).toContainText("$25");
  await expect(pending).toContainText("2 free months");
  await expect(pending).toContainText("Pending");
  await captureScreenshot(page, testInfo, "admin-access-grants");

  await pending.getByRole("button", { name: "Revoke" }).click();
  await expect(pending).toContainText("Revoked");
  await expect(pending.getByRole("button", { name: "Revoke" })).toHaveCount(0);
});
